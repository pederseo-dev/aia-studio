// ▶ Live (Puppet): el muñeco en marcha dentro del editor, con el mismo runtime que la app (src/core/vivo.js). Con
// Live encendido el documento no se edita (▶ Live está en la barra de Puppet, arriba de Clips): los botones de los clips los disparan, los controles de Parameters son
// los valores de la app (no se guardan) y el lienzo muestra lo que vería la app. Ver docs/decision-animacion.md §9.

import { createLive } from '../core/live.js';
import { findObject } from '../core/document.js';
import { read } from '../core/schema.js';
import { manifest, manifestText } from '../core/manifest.js';
import { notify, schema, state, setState, subscribe } from './state.js';

let live = null;
let frame = null;
let before = 0;
// Los valores de Parameters de antes de Live: al apagarlo vuelven (los de Live son de la app y no se quedan).
let beforeParams = null;

/** El runtime en marcha (o null si Live está apagado). */
export const liveRuntime = () => live;

function step(now) {
  if (!live) return;
  // Un cuadro largo (la pestaña estuvo oculta) no salta el fundido entero.
  const dt = Math.min(0.1, (now - before) / 1000);
  before = now;
  live.advance(dt);
  setState({ livePose: live.pose(), liveState: live.state() });
  frame = requestAnimationFrame(step);
}

export function turnOnLive() {
  if (live || !state.doc || state.mode !== 'puppet') return;
  // Solo los valores que siguen valiendo (un param pudo borrarse o perder esa opción mientras tanto).
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

/** Apaga Live. `restaurar`: los valores de Parameters vuelven a los de antes (no si se cambió de modo o de documento). */
export function turnOffLive({ restore = true } = {}) {
  if (!live) return;
  cancelAnimationFrame(frame);
  live = null;
  setState({ live: false, livePose: null, liveState: null, ...(restore ? { params: beforeParams } : {}) });
  beforeParams = null;
}

/** ■ Stop all: todo lo que disparó la app sale con su fundido (los auto siguen). */
export const stopAll = () => live?.stop();

/**
 * Lo que verá la IA de la app (el mismo texto que get_manifest), en un diálogo. Así la persona ve lo mismo que la IA
 * que edita: params con lo que mueven, clips con lo que pisan y los problemas.
 */
export function showManifest() {
  if (!state.doc) return;
  const dialog = document.createElement('dialog');
  dialog.className = 'manifiesto';
  dialog.innerHTML = '<h2>What the app’s AI sees</h2><pre></pre><form method="dialog"><button type="submit">Close</button></form>';
  dialog.querySelector('pre').textContent = manifestText(manifest(state.doc, schema));
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

export const toggleLive = () => (live ? turnOffLive() : turnOnLive());

/** Dispara un clip (play) o lo saca (stop) en vivo; los errores van al aviso. */
export function triggerClip(id, { stop = false } = {}) {
  if (!live) return;
  try {
    if (stop) live.stop(id);
    else live.play(id);
  } catch (e) {
    notify(e.message, true);
  }
}

/** Un valor de la app (los controles de Parameters con Live encendido). */
/** Reset: todos los params a su valor inicial (con Live, los de la app; si no, la vista de params). */
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

// Live es de Puppet y de un documento: cambiar de modo o de documento lo apaga. Con Live no se edita a mano, pero el
// documento puede cambiar igual (la IA por MCP, o deshacer): el runtime sigue con el nuevo.
subscribe((c) => {
  if (!live) return;
  if (('mode' in c && state.mode !== 'puppet') || 'id' in c) return turnOffLive({ restore: false });
  if ('doc' in c && state.doc) live.update(state.doc);
});
