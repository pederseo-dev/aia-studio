// ▶ Live (Puppet): the puppet running inside the editor, with the same runtime as the app (src/core/live.js). With
// Live on the document is not edited (▶ Live is in the Puppet bar, above Clips): the clip buttons trigger them, the Parameters controls are
// the app's values (they are not saved) and the canvas shows what the app would see. See docs/decision-animacion.md §9.

import { createLive } from '../core/live.js';
import { findObject } from '../core/document.js';
import { read } from '../core/schema.js';
import { manifest, manifestText } from '../core/manifest.js';
import { notify, schema, state, setState, subscribe } from './state.js';

let live = null;
let frame = null;
let before = 0;
// The Parameters values from before Live: restored when it is turned off (Live's belong to the app and do not stay).
let beforeParams = null;

function step(now) {
  if (!live) return;
  // A long frame (the tab was hidden) does not skip the whole fade.
  const dt = Math.min(0.1, (now - before) / 1000);
  before = now;
  live.advance(dt);
  setState({ livePose: live.pose(), liveState: live.state() });
  frame = requestAnimationFrame(step);
}

export function turnOnLive() {
  if (live || !state.doc || state.mode !== 'puppet') return;
  // Only the values that are still valid (a param could have been deleted or lost that option in the meantime).
  const valid = Object.fromEntries(
    Object.entries(state.params ?? {}).filter(([id, v]) => {
      const p = findObject(state.doc, id);
      return p?.type === 'param' && (read(schema, p, 'kind') !== 'enum' || read(schema, p, 'options').includes(v));
    }),
  );
  try {
    live = createLive(state.doc, schema, { params: valid, seed: Math.floor(Math.random() * 2 ** 31) });
  } catch (e) {
    live = null;
    return notify(e.message, true);
  }
  beforeParams = state.params;
  before = performance.now();
  setState({ live: true, playing: false, previewDoc: null, livePose: live.pose(), liveState: live.state() });
  frame = requestAnimationFrame(step);
}

/** Turns Live off. `restore`: the Parameters values return to the earlier ones (not if mode or document changed). */
export function turnOffLive({ restore = true } = {}) {
  if (!live) return;
  cancelAnimationFrame(frame);
  live = null;
  setState({ live: false, livePose: null, liveState: null, ...(restore ? { params: beforeParams } : {}) });
  beforeParams = null;
}

/** ■ Stop all: everything the app triggered leaves with its fade (the auto ones continue). */
export const stopAll = () => live?.stop();

/**
 * What the app's AI will see (the same text as get_manifest), in a dialog. That way the person sees the same as the AI
 * that edits: params with what they move, clips with what they override and the problems.
 */
export function showManifest() {
  if (!state.doc) return;
  const dialog = document.createElement('dialog');
  dialog.className = 'manifest';
  dialog.innerHTML = '<h2>What the app’s AI sees</h2><pre></pre><form method="dialog"><button type="submit">Close</button></form>';
  dialog.querySelector('pre').textContent = manifestText(manifest(state.doc, schema));
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

export const toggleLive = () => (live ? turnOffLive() : turnOnLive());

/** Triggers a clip (play) or takes it out (stop) live; errors go to the notice. */
export function triggerClip(id, { stop = false } = {}) {
  if (!live) return;
  try {
    if (stop) live.stop(id);
    else live.play(id);
  } catch (e) {
    notify(e.message, true);
  }
}

/** A value of the app (the Parameters controls with Live on). */
/** Reset: all params to their initial value (with Live, the app's; otherwise, the params view). */
export function resetParams() {
  if (!state.doc) return;
  if (!live) return setState({ ...(state.pose && findObject(state.doc, state.pose)?.type === 'pose' ? { pose: null } : {}), params: {} });
  for (const p of state.doc.objects.filter((o) => o.type === 'param')) {
    live.set(p.id, read(schema, p, 'kind') === 'enum' ? (read(schema, p, 'initial') ?? read(schema, p, 'options')[0]) : read(schema, p, 'default'));
  }
  setState({ params: {} });
}

export function putParamLive(id, value) {
  if (!live) return;
  try {
    live.set(id, value);
    setState({ params: { ...(state.params ?? {}), [id]: value } });
  } catch (e) {
    notify(e.message, true);
  }
}

// Live belongs to Puppet and to one document: changing mode or document turns it off. With Live nothing is edited by
// hand, but the document can change anyway (the AI through MCP, or undo): the runtime continues with the new one.
subscribe((c) => {
  if (!live) return;
  if (('mode' in c && state.mode !== 'puppet') || 'id' in c) return turnOffLive({ restore: false });
  if ('doc' in c && state.doc) live.update(state.doc);
});
