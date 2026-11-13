// Modos del editor (Design · Animate · Puppet), la timeline de abajo y la biblioteca de clips de Puppet. Ver
// docs/decision-animacion.md.
//
// Un clip abierto se edita como una pose (estado.pose = id del clip): lo que se cambia en el lienzo o en el inspector
// queda como keyframe en el tiempo del playhead (autokey, ver opsDePose en huesos.js).

import { ICONOS } from './icons.js';
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

/** Crea un clip nuevo (pide el nombre) y lo abre. */
function newClip(usage) {
  if (!state.doc) return;
  const id = fromId(prompt(usage === 'puppet' ? 'Clip name (e.g. wave, blink, idle):' : 'Scene name (e.g. intro, scene_1):', ''), 'clip');
  if (!id) return;
  if (findObject(state.doc, id)) return notify(`"${id}" already exists`, true);
  execute([{ op: 'create', type: 'animation', id, props: { usage, duration: usage === 'puppet' ? 1 : 5 } }], `create ${usage === 'puppet' ? 'clip' : 'scene'} ${id}`);
  openClip(id);
}

function openClip(id) {
  stop();
  setState({ pose: id, time: 0, editing: null, vertex: null });
}

// ---------- Reproducción ----------

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

// ---------- Modos ----------

export function mountModes(buttons) {
  for (const b of buttons.querySelectorAll('[data-modo]')) {
    b.title = MODES[b.dataset.modo];
    b.addEventListener('click', () => changeMode(b.dataset.modo));
  }
  subscribe((c) => {
    if (!('mode' in c) && !('id' in c)) return;
    document.body.dataset.modo = state.mode;
    for (const b of buttons.querySelectorAll('[data-modo]')) b.setAttribute('aria-selected', String(b.dataset.modo === state.mode));
  });
  document.body.dataset.modo = state.mode;
}

export function changeMode(mode) {
  stop();
  const doc = state.doc;
  if (mode === 'design') return setState({ mode, pose: null, params: null, editing: null, vertex: null });
  if (mode === 'animate') {
    // Se abre la primera escena, si hay.
    const scene = doc?.objects.find((o) => o.type === 'animation' && read(schema, o, 'usage') === 'animate');
    return setState({ mode, pose: scene?.id ?? null, params: null, time: 0, editing: null, vertex: null });
  }
  // Puppet: se ve la mezcla de los params; los clips se abren desde la biblioteca de la derecha.
  setState({ mode, pose: null, params: state.params ?? {}, time: 0, editing: null, vertex: null });
}

// ---------- Biblioteca de clips (Puppet) ----------

/** Cómo suena un clip en vivo, en pocas palabras: «base», «gesture», «auto: every 2–6 s», «auto: always». */
function liveRole(clip) {
  const auto = read(schema, clip, 'auto');
  if (auto === 'repeat') return `auto · every ${n(read(schema, clip, 'repeat_min'))}–${n(read(schema, clip, 'repeat_max'))} s`;
  if (auto === 'always') return 'auto · always';
  return read(schema, clip, 'loop') === 'once' ? 'gesture' : 'base';
}

export function mountClips(root, list, newButton, liveButton, manifestButton, deleteButton) {
  // 🗑 borra el clip de Puppet seleccionado (en Assets) o, si no, el abierto.
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
    root.classList.toggle('en-vivo', state.live);
    liveButton.textContent = state.live ? '■ Live' : '▶ Live';
    liveButton.setAttribute('aria-pressed', String(state.live));
    liveButton.title = state.live
      ? 'Stop Live and go back to editing'
      : 'Live: play the puppet as the app will. Clip buttons trigger clips (with fades), Parameters are the app’s values, and nothing is saved.';
    newButton.disabled = state.live;
    if (root.hidden) return;
    const clips = doc.objects.filter((o) => o.type === 'animation' && read(schema, o, 'usage') === 'puppet');
    if (!clips.length) {
      list.innerHTML = '<p class="ayuda">No clips yet. A clip is a short animation the app or its AI triggers (wave, blink, idle). Create one with + above.</p>';
      return;
    }
    list.replaceChildren(...clips.map((clip) => (state.live ? liveRow(clip) : rowToEdit(clip))));
    if (state.live) updateLive();
  }

  function rowToEdit(clip) {
    const open = state.pose === clip.id;
    const row = document.createElement('div');
    row.className = `clip${open ? ' abierto' : ''}`;
    const button = Object.assign(document.createElement('button'), { type: 'button', className: 'nombre' });
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

  /** Con Live: el botón dispara el clip (los auto suenan solos); ■ lo saca. La barra de abajo es su peso. */
  function liveRow(clip) {
    const auto = read(schema, clip, 'auto') !== 'off';
    const row = document.createElement('div');
    row.className = `clip vivo${auto ? ' auto' : ''}`;
    row.dataset.clip = clip.id;
    const button = Object.assign(document.createElement('button'), { type: 'button', className: 'nombre', disabled: auto });
    const description = read(schema, clip, 'description');
    button.innerHTML = `<b></b><small></small><span class="peso"></span>`;
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

  /** Cada cuadro: el peso de cada clip que suena, sin rehacer los botones (un clic no se perdería a mitad). */
  function updateLive() {
    const playing = state.liveState?.playing ?? [];
    for (const row of list.querySelectorAll('.clip.vivo')) {
      const s = playing.filter((x) => x.clip === row.dataset.clip);
      const weight = Math.max(0, ...s.map((x) => x.weight));
      row.style.setProperty('--peso', `${Math.round(weight * 100)}%`);
      row.classList.toggle('sonando', weight > 0);
      const stop = row.querySelector('.play');
      stop.disabled = !s.some((x) => !x.leaving && x.layer !== 'auto');
    }
  }
}

// ---------- Timeline ----------

export function mountTimeline(root) {
  // Keyframe elegido: { id, prop, t } (solo del editor).
  let chosen = null;
  // Grupos de la timeline abiertos o cerrados a mano (id → true/false); si no se tocó, solo el principal va abierto.
  const folded = new Map();
  // «Scale keys» al cambiar Length: se recuerda mientras el editor está abierto.
  let scaleKeys = false;
  root.tabIndex = -1;

  subscribe((c) => {
    if ('live' in c) return draw();
    // Con Live, cada cuadro solo rehace las filas (el botón «Stop all» no se rehace: un clic no se perdería a mitad).
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
   * Con Live encendido, la timeline muestra qué suena: una fila por clip (base, gestos, auto) con su peso (la barra) y
   * por dónde va (la marca). Se rehace en cada cuadro; no tiene nada que se pueda tocar.
   */
  function live(doc) {
    const box = document.createElement('div');
    box.className = 'tiempo-vivo';
    const title = document.createElement('p');
    title.className = 'ayuda';
    title.textContent = 'Live: what the app sees. Click clips on the right to play them, move Parameters, ■ Live to edit again.';
    const stop = Object.assign(document.createElement('button'), { type: 'button', className: 'parar-todo', textContent: '■ Stop all', title: 'Fade out everything the app played (auto clips keep playing), like stop() in the app' });
    stop.addEventListener('click', stopAll);
    const head = document.createElement('div');
    head.className = 'cabeza-vivo';
    head.append(title, stop);
    const rows = document.createElement('div');
    rows.className = 'filas-vivo';
    box.append(head, rows);
    queueMicrotask(liveRows);
    return box;
  }

  /** Las filas de lo que suena (Live), en su lugar; y si hay algo que parar. */
  function liveRows() {
    const doc = state.doc;
    const box = root.querySelector('.filas-vivo');
    if (!box || !doc) return;
    box.replaceChildren();
    const playing = state.liveState?.playing ?? [];
    const stop = root.querySelector('.parar-todo');
    if (stop) stop.disabled = !playing.some((s) => s.layer !== 'auto' && !s.leaving);
    const names = { base: 'base', gesto: 'gesture', auto: 'auto' };
    for (const s of playing) {
      const clip = findObject(doc, s.clip);
      if (!clip) continue;
      const d = read(schema, clip, 'duration');
      const progress = Math.min(1, localTime(schema, clip, s.t) / d);
      const row = document.createElement('div');
      row.className = `fila-vivo capa-${s.layer}${s.leaving ? ' saliendo' : ''}`;
      row.innerHTML = '<span class="nombre"></span><span class="capa"></span><span class="barra"><span class="lleno"></span><span class="avance"></span></span><span class="valor"></span>';
      row.querySelector('.nombre').textContent = s.clip;
      row.querySelector('.capa').textContent = `${names[s.layer]}${s.leaving ? ' · out' : ''}`;
      (/** @type {HTMLElement} */ (row.querySelector('.lleno'))).style.width = `${Math.round(s.weight * 100)}%`;
      (/** @type {HTMLElement} */ (row.querySelector('.avance'))).style.left = `${progress * 100}%`;
      row.querySelector('.valor').textContent = `${Math.round(s.weight * 100)}%`;
      row.title = `${s.clip}: weight ${Math.round(s.weight * 100)}%, at ${n(localTime(schema, clip, s.t))} of ${n(d)} s`;
      box.append(row);
    }
    if (!playing.length) {
      const p = document.createElement('p');
      p.className = 'ayuda';
      p.textContent = 'Nothing is playing: the setup with the parameters. Click a base clip (loop) to start.';
      box.append(p);
    }
  }

  function empty() {
    const p = document.createElement('p');
    p.className = 'ayuda';
    p.innerHTML =
      state.mode === 'animate'
        ? 'No scene yet. Create one with + (above): then move the playhead and change things on the canvas or in the inspector — each change is keyed at the playhead.'
        : 'Pick a clip on the right (or create one with + above) to edit its keyframes here.';
    return p;
  }

  /**
   * Arriba, las pestañas como las de los documentos: en Animate, una por escena (× la borra, se puede deshacer); en
   * Puppet, el clip abierto (× lo cierra). El + crea una escena o un clip.
   */
  function tabs(doc, clip) {
    const row = document.createElement('div');
    row.className = 'pestanas-tiempo';
    row.setAttribute('role', 'tablist');
    const animate = state.mode === 'animate';
    const list = animate ? doc.objects.filter((o) => o.type === 'animation' && read(schema, o, 'usage') === 'animate') : clip ? [clip] : [];
    for (const c of list) {
      const active = c.id === clip?.id;
      const p = document.createElement('div');
      p.className = `pestana${active ? ' activa' : ''}`;
      p.setAttribute('role', 'tab');
      p.setAttribute('aria-selected', String(active));
      p.title = read(schema, c, 'description') || c.id;
      const closeTitle = animate ? 'Delete this scene (undo brings it back)' : 'Close the clip';
      p.innerHTML = `<span class="titulo"></span><button type="button" class="cerrar" title="${closeTitle}">×</button>`;
      p.querySelector('.titulo').textContent = c.id;
      p.addEventListener('click', (e) => {
        if (!(/** @type {Element} */ (e.target)).closest('.cerrar')) return active || openClip(c.id);
        if (!animate) return closeClip();
        if (!confirm(`Delete scene "${c.id}" and all its keyframes?`)) return;
        stop();
        const other = list.find((o) => o.id !== c.id);
        execute([{ op: 'delete', target: c.id }], `delete scene ${c.id}`);
        if (active) setState({ pose: other?.id ?? null, time: 0 });
      });
      row.append(p);
    }
    const created = Object.assign(document.createElement('button'), { type: 'button', className: 'nueva-pestana', title: animate ? 'New scene' : 'New clip', innerHTML: ICONOS.agregar });
    created.setAttribute('aria-label', created.title);
    created.addEventListener('click', () => newClip(animate ? 'animate' : 'puppet'));
    row.append(created);
    return row;
  }

  function closeClip() {
    stop();
    setState({ pose: null, params: state.params ?? {} });
  }

  /** « y »: el keyframe anterior o siguiente del clip (o el principio y el final, si no hay más). */
  function skip(clip, direction) {
    stop();
    const times = keyTimes(clip).filter((t) => !sameTime(t, state.time) && (direction < 0 ? t < state.time : t > state.time));
    const t = direction < 0 ? (times.at(-1) ?? 0) : (times[0] ?? read(schema, clip, 'duration'));
    setState({ time: t });
  }

  function bar(doc, clip) {
    const container = document.createElement('div');
    container.className = 'cabeza-tiempo';
    container.append(tabs(doc, clip));
    if (!clip) return container;
    const row = document.createElement('div');
    row.className = 'barra-tiempo';
    const left = document.createElement('div');
    left.className = 'zona izquierda';
    const centro = document.createElement('div');
    centro.className = 'zona centro';
    const div = document.createElement('div');
    div.className = 'zona derecha';
    row.append(left, centro, div);
    container.append(row);

    const duration = read(schema, clip, 'duration');
    centro.append(
      button('«', 'Previous keyframe (or the start)', () => skip(clip, -1)),
      button(state.playing ? '⏸' : '▶', state.playing ? 'Pause' : 'Play', () => (state.playing ? stop() : startPlayback()), 'play'),
      button('»', 'Next keyframe (or the end)', () => skip(clip, 1)),
    );
    left.append(Object.assign(document.createElement('span'), { className: 'reloj' }));

    const durationField = Object.assign(document.createElement('input'), { type: 'number', min: 0.05, step: 0.1, value: n(duration), title: 'Duration in seconds' });
    durationField.addEventListener('change', () => {
      const v = Number(durationField.value);
      if (!(v > 0)) return draw();
      // Con «Scale keys», los keyframes se estiran o comprimen en proporción (lo mismo que scale_time del MCP).
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
    const durationLabel = Object.assign(document.createElement('label'), { className: 'campo-corto', textContent: 'Length' });
    durationLabel.append(durationField, document.createTextNode('s'));
    const scale = Object.assign(document.createElement('input'), { type: 'checkbox', checked: scaleKeys });
    scale.addEventListener('change', () => (scaleKeys = scale.checked));
    const scaleLabel = Object.assign(document.createElement('label'), { className: 'campo-corto', title: 'When on, changing Length stretches or squeezes every keyframe in proportion (one undo step)' });
    scaleLabel.append(scale, document.createTextNode('Scale keys'));

    const loop = document.createElement('select');
    loop.title = 'once: plays once and holds the end · loop: starts over · pingpong: back and forth';
    for (const v of ['once', 'loop', 'pingpong']) loop.append(new Option(v, v, false, v === read(schema, clip, 'loop')));
    loop.addEventListener('change', () => execute([{ op: 'set', target: clip.id, props: { loop: loop.value } }], `${clip.id} loop ${loop.value}`));

    left.append(durationLabel, scaleLabel, loop);
    div.append(button('◆ Key', 'Key the selected object at the playhead: its animated properties (or, if it has none, its rotation and position)', () => pinSelection(clip)));

    // Una pose entera como keyframes en el playhead, y volver al montaje (lo mismo que pose y setup en set_keys).
    const poses = doc.objects.filter((o) => o.type === 'pose');
    if (poses.length) {
      const withPose = document.createElement('select');
      withPose.title = 'Key the values of a pose at the playhead: all of it, or only what is selected (like pose with only in set_keys)';
      withPose.append(new Option('◆ Pose…', ''), ...poses.map((p) => new Option(p.id, p.id)));
      // Lo seleccionado y lo que cuelga de ello (un grupo o un skeleton valen por sus partes).
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

    // Drivers que suman encima de pistas del clip (lo mismo que avisan set_keys y render_preview a la IA).
    const warnings = clipWarnings(doc, schema, clip, state.params ?? {});
    if (warnings.length) div.append(Object.assign(document.createElement('span'), { className: 'aviso-drivers', textContent: `⚠ ${warnings.length} driver${warnings.length > 1 ? 's' : ''} add on top`, title: warnings.join('\n') }));

    // Curva y borrar del keyframe elegido (en todas las propiedades de su canal que tienen keyframe ahí).
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
      curve.append(new Option('cubic-bezier…', 'editar'));
      curve.addEventListener('change', () => {
        /** @type {any} */
        let ease = curve.value;
        if (ease === 'custom' || ease === 'mixed') return;
        if (ease === 'editar') {
          // Como en CSS: x1, y1, x2, y2 (x entre 0 y 1; y puede pasarse para un rebote).
          const previewDoc = Array.isArray(first) ? first.join(', ') : '0.3, 1.6, 0.6, 1';
          const text = prompt('cubic-bezier x1, y1, x2, y2 (as in CSS; y outside 0…1 overshoots):', previewDoc);
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
      const label = Object.assign(document.createElement('label'), { className: 'campo-corto', textContent: `${chosen.id} ${chosen.channel} @ ${n(chosen.t)} s` });
      label.append(curve);
      if (current !== 'mixed') label.append(curveShape(first ?? 'linear'));
      div.append(label, button('Delete key', 'Delete this keyframe (Del)', () => deleteChosen(clip)));
    }
    if (state.mode === 'puppet') {
      const description = Object.assign(document.createElement('input'), { type: 'text', className: 'descripcion', value: read(schema, clip, 'description'), placeholder: 'What it does (for the app’s AI)' });
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

  /** ◆ Key: los objetos seleccionados en el tiempo del playhead, cada uno con lo que tiene pista o, si no, rotación y posición. */
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

  /** Lo seleccionado que tiene canales (objetos, huesos y params; no recursos), en el orden en que se eligió. */
  function chosenObjects() {
    // Los params son de Puppet: en una escena no tienen canal (pudieron quedar seleccionados al venir de Puppet).
    const params = !isScene(schema, clipVisible());
    return state.selected.map((id) => findObject(state.doc, id)).filter((o) => o && (o.type === 'param' ? params : !schema.types.get(o.type)?.resource));
  }

  /** Abierto o cerrado: lo que eligió el usuario o, si no lo tocó, abierto solo el principal (o el único). */
  function openGroup(id, howMany) {
    return folded.has(id) ? folded.get(id) : howMany === 1 || id === state.selection;
  }

  /**
   * Keyframes en el playhead con estos valores ({ objeto: { propiedad: valor } }; un param, { value }). Con `vistos`,
   * son lo que se ve y se les resta lo que suman los drivers; los de una pose o del montaje se guardan tal cual.
   */
  function pinValues(clip, values, que, seen = true) {
    const params = state.params ?? {};
    let tracks = clip.tracks ?? {};
    for (const [id, fields] of Object.entries(values)) {
      for (const [k, v] of Object.entries(fields)) tracks = putKey(tracks, id, k, state.time, seen ? valueToSave(state.doc, schema, clip, state.time, params, id, k, v) : v);
    }
    execute([{ op: 'set', target: clip.id, props: { tracks } }], `${clip.id}: key ${que} at ${n(state.time)} s`);
  }

  /** Borra un canal entero (todos los keyframes de sus propiedades). */
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

  // Del borra el keyframe elegido mientras el foco está en la timeline (sin llegar al atajo de borrar objetos).
  root.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select')) return;
    const clip = openedClip();
    if ((e.key === 'Delete' || e.key === 'Backspace') && chosen && clip) {
      e.stopPropagation();
      deleteChosen(clip);
    }
  });

  /**
   * La regla, una fila con todos los keyframes del clip y, como en Moho, los canales de lo seleccionado: todos los
   * animables, también los que todavía no tienen keyframes (◇ los keya en el playhead).
   */
  function tracks(clip) {
    const duration = read(schema, clip, 'duration');
    const body = document.createElement('div');
    body.className = 'pistas';
    const left = (t) => `${(t / duration) * 100}%`;

    const rule = document.createElement('div');
    rule.className = 'fila-pista regla';
    const lane = document.createElement('div');
    lane.className = 'carril';
    const markStep = duration > 20 ? 5 : duration > 8 ? 2 : duration > 3 ? 1 : duration > 1 ? 0.5 : 0.25;
    for (let t = 0; t <= duration + 1e-9; t += markStep) {
      const mark = Object.assign(document.createElement('span'), { className: 'marca', textContent: `${n(t)}s` });
      mark.style.left = left(t);
      lane.append(mark);
    }
    rule.append(Object.assign(document.createElement('span'), { className: 'etiqueta' }), lane);
    body.append(rule);

    // Todos los keyframes del clip, en gris: para ver el ritmo y saber dónde hay algo (clic = llevar el playhead ahí).
    const all = row('All keys', 'Every keyframe of the clip, of any object. Click one to move the playhead there.');
    all.classList.add('resumen');
    for (const t of keyTimes(clip)) {
      const diamond = Object.assign(document.createElement('span'), { className: 'clave resumen', title: `Keyframes at ${n(t)} s. Click to go there; drag to move the whole moment (every keyframe at ${n(t)} s).` });
      diamond.style.left = left(t);
      diamond.addEventListener('pointerdown', (e) => dragMoment(e, clip, null, t, all.lane));
      all.lane.append(diamond);
    }
    body.append(all);

    // Como en Rive: un grupo por cada cosa seleccionada (en Layers o en el lienzo), plegable; abierto, sus canales como en Moho.
    const objs = chosenObjects().filter((o) => channelsOf(o).length);
    if (!objs.length) {
      // Sin selección: qué objetos tiene animados el clip, para ir a ellos.
      const help = document.createElement('div');
      help.className = 'ayuda-canales';
      const animated = Object.keys(clip.tracks ?? {}).filter((id) => findObject(state.doc, id));
      help.append(document.createTextNode(state.selection ? `${state.selection} has no animatable channels. ` : 'Select objects or bones (Ctrl + click in Layers adds more) to see their channels. '));
      if (animated.length) {
        help.append(document.createTextNode('Animated: '));
        for (const id of animated) help.append(button(id, `Select ${id}`, () => select(id), 'chip'));
      }
      body.append(help);
    }
    for (const obj of objs) {
      const channels = channelsOf(obj);
      const open = openGroup(obj.id, objs.length);
      // La fila del objeto: ▸/▾ pliega, el nombre lo hace principal, y en el carril todos sus keyframes juntos.
      const head = row(obj.id, `${obj.id} (${obj.type})`);
      head.classList.add('grupo');
      if (obj.id === state.selection) head.classList.add('principal');
      const flecha = button(open ? '▾' : '▸', open ? `Collapse ${obj.id}` : `Expand ${obj.id} to see its channels`, () => {
        folded.set(obj.id, !open);
        draw();
      }, 'plegar');
      head.label.prepend(flecha);
      const name = /** @type {HTMLElement} */ (head.label.querySelector('.nombre-pista'));
      name.style.cursor = 'pointer';
      name.addEventListener('click', () => selectSeveral(state.selected, obj.id));
      const props = channels.flatMap((c) => c.props);
      for (const t of channelTimes(clip, obj.id, props)) {
        const diamond = Object.assign(document.createElement('span'), { className: 'clave resumen', title: `${obj.id}: keyframes at ${n(t)} s. Click to go there; drag to move all of ${obj.id}'s keyframes at ${n(t)} s.` });
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

  /** Una fila de canal (Position, Rotation…) de un objeto: ◇/◆ para keyarla, × para borrarla y sus keyframes. */
  function channelRow(clip, obj, channel, left) {
    const withTrack = channel.props.some((p) => clip.tracks?.[obj.id]?.[p]?.length);
    const f = row(channel.name, `${obj.id}: ${channel.props.join(', ')}`);
    f.classList.add('canal');
    if (!withTrack) f.classList.add('vacia');
    const pin = button(withTrack ? '◆' : '◇', `Key ${obj.id} ${channel.name} at the playhead`, () => pinChannel(clip, obj, channel), 'clavar-canal');
    const remove = button('×', `Delete the whole ${channel.name} track of ${obj.id} (all its keyframes)`, () => deleteChannel(clip, obj.id, channel), 'quitar-pista');
    if (!withTrack) remove.hidden = true;
    f.label.append(pin, remove);
    // Un param mueve todas las poses de sus drivers (también las que no se ven en la timeline): se dice al lado.
    if (obj.type === 'param') {
      const poses = state.doc.objects.filter((o) => o.type === 'driver' && o.param === obj.id && findObject(state.doc, o.pose)?.type === 'pose');
      const text = poses.length ? `→ ${poses.map((d) => d.pose).join(', ')}` : '→ no driver';
      const detail = poses.map((d) => `${d.pose} (driver ${d.id}): ${Object.keys(findObject(state.doc, d.pose).values ?? {}).join(', ') || 'empty'}`).join('\n');
      f.label.append(Object.assign(document.createElement('span'), { className: 'poses-param', textContent: text, title: poses.length ? `Animating ${obj.id} moves these poses (they all add up):\n${detail}` : `${obj.id} has no driver: animating it moves nothing` }));
    }
    for (const t of channelTimes(clip, obj.id, channel.props)) {
      const keys = keysIn(clip, obj.id, channel.props, t);
      const diamond = document.createElement('span');
      const isChosen = chosen && chosen.id === obj.id && chosen.channel === channel.name && sameTime(chosen.t, t);
      diamond.className = `clave ${curveClass(keys)}${isChosen ? ' elegida' : ''}`;
      diamond.style.left = left(t);
      diamond.title = `${obj.id} ${channel.name} at ${n(t)} s: ${keys.map(([p, c]) => `${p} = ${summarize(c.value)}`).join(', ')} (${curveName(keys)}). Drag to move it in time.`;
      diamond.addEventListener('pointerdown', (e) => dragKey(e, clip, obj.id, channel, t, f.lane));
      f.lane.append(diamond);
    }
    return f;
  }

  /** El playhead y el clic o arrastre en la regla o en un carril vacío para moverlo. */
  function closeTracks(body, duration) {
    const playhead = document.createElement('div');
    playhead.className = 'playhead';
    body.append(playhead);
    // Clic o arrastre en la regla o en un carril vacío: mover el playhead (con imán a los cuadros).
    body.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('.clave, .etiqueta, .ayuda-canales')) return;
      const zone = body.querySelector('.carril').getBoundingClientRect();
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

  /** Una fila de la timeline: etiqueta a la izquierda y carril a la derecha. */
  function row(text, title) {
    const div = document.createElement('div');
    div.className = 'fila-pista';
    const label = document.createElement('span');
    label.className = 'etiqueta';
    label.append(Object.assign(document.createElement('span'), { className: 'nombre-pista', textContent: text, title: title }));
    const lane = document.createElement('div');
    lane.className = 'carril';
    div.append(label, lane);
    return Object.assign(div, { label, lane });
  }

  /** ◇/◆ de un canal: keya sus propiedades en el playhead con lo que se ve (sin el aporte de los drivers). */
  function pinChannel(clip, obj, channel) {
    const pose = activePose();
    const values = Object.fromEntries(channel.props.map((k) => [k, obj.type === 'param' ? pose?.params?.[obj.id] : (pose?.values?.[obj.id]?.[k] ?? effectiveValue(schema, state.doc, obj, k))]));
    pinValues(clip, { [obj.id]: values }, `${obj.id} ${channel.name}`);
  }

  /** Clic en un keyframe lo elige (y lleva el playhead ahí); arrastrarlo lo mueve en el tiempo, con todo su canal. */
  function dragKey(e, clip, id, channel, t0, lane) {
    if (e.button !== 0) return;
    e.stopPropagation();
    stop();
    root.focus();
    // Se mide antes de elegir: elegir redibuja la timeline y este carril deja de estar en la página.
    const zone = lane.getBoundingClientRect();
    const props = keysIn(clip, id, channel.props, t0).map(([p]) => p);
    chosen = { id, props, t: t0, channel: channel.name };
    // Cambia la barra (curva y borrar del keyframe elegido): se redibuja ya, no solo el playhead.
    draw();
    setState({ time: t0 });
    const duration = read(schema, clip, 'duration');
    const x0 = e.clientX;
    let created = t0;
    // moverClave falla si en el destino ya hay otro keyframe de la pista (soltarlo encima lo borraría).
    const ops = (t) => {
      let tracks = clip.tracks;
      for (const p of props) tracks = moveKey(tracks, id, p, t0, t);
      return [{ op: 'set', target: clip.id, props: { tracks } }];
    };
    // Elegir el keyframe redibuja la timeline (el rombo se reemplaza): el arrastre se sigue en window.
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
      let lote;
      try {
        lote = ops(created);
      } catch (error) {
        preview(null);
        return notify(error.message, true);
      }
      chosen = { id, props, t: roundTime(created), channel: channel.name };
      execute(lote, `${clip.id}: move key ${id} ${channel.name} ${n(t0)} → ${n(created)} s`);
    }, { once: true });
  }

  /**
   * Un ◆ de «All keys» (id null) o de la fila de un objeto: clic lleva el playhead ahí; arrastrar mueve el momento
   * entero (todos los keyframes de ese tiempo, del clip o del objeto), como move_keys de la IA.
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
      let lote;
      try {
        lote = ops(created);
      } catch (error) {
        preview(null);
        return notify(error.message, true);
      }
      chosen = null;
      execute(lote, `${clip.id}: move ${idOnly ? `${idOnly} keys` : 'keys'} ${n(t0)} → ${n(created)} s`);
    }, { once: true });
  }

  function movePlayhead() {
    const clip = clipVisible();
    if (!clip) return;
    const duration = read(schema, clip, 'duration');
    const playhead = root.querySelector('.playhead');
    const lane = root.querySelector('.carril');
    if (playhead && lane) {
      const base = lane.offsetLeft;
      playhead.style.left = `${base + (Math.min(state.time, duration) / duration) * lane.offsetWidth}px`;
    }
    const clock = root.querySelector('.reloj');
    if (clock) clock.textContent = `${state.time.toFixed(2)} s · frame ${Math.round(state.time * fps())}`;
  }
  new ResizeObserver(movePlayhead).observe(root);
}

// Canales como en Moho: la posición (x, y) y la escala (scaleX, scaleY) van juntas en una fila; un param, su valor.
/** @type {[string, string[]][]} */
const JOINED = [['Position', ['x', 'y']], ['Rotation', ['rotation']], ['Scale', ['scaleX', 'scaleY']]];
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

/** Tiempos con keyframe en alguna de las propiedades de un canal. */
function channelTimes(clip, id, props) {
  const times = [];
  for (const p of props) for (const c of clip.tracks?.[id]?.[p] ?? []) if (!times.some((t) => sameTime(t, c.t))) times.push(c.t);
  return times.sort((a, b) => a - b);
}

/** Los keyframes [propiedad, keyframe] de un canal en el tiempo t. */
function keysIn(clip, id, props, t) {
  return (props ?? []).flatMap((p) => {
    const c = clip?.tracks?.[id]?.[p]?.find((k) => sameTime(k.t, t));
    return c ? [[p, c]] : [];
  });
}

/** El color del ◆ dice la curva del tramo que sale de él (como la forma del keyframe en Moho). */
function curveClass(keys) {
  const curves = new Set(keys.map(([, c]) => (Array.isArray(c.ease) ? 'bezier' : (c.ease ?? 'linear'))));
  if (curves.size > 1) return 'curva-mixta';
  const [curve] = curves;
  return `curva-${curve.startsWith('ease-') ? 'ease' : curve}`;
}

/** Un dibujito de la curva de un tramo (tiempo → avance), para ver la forma sin adivinar los números. */
function curveShape(ease) {
  const [width, height, margin] = [36, 20, 4];
  const y = (v) => margin + (1 - v) * (height - 2 * margin);
  const points = Array.from({ length: 25 }, (_, i) => {
    const f = i / 24;
    return `${(f * width).toFixed(1)},${y(ease === 'step' ? (f < 1 ? 0 : 1) : applyCurve(ease, f)).toFixed(1)}`;
  });
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('class', 'forma-curva');
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
