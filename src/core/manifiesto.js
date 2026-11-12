// El manifiesto: lo que la IA de la app sabe del muñeco para manejarlo en vivo (play, set, stop). Sale del documento
// y nada más, así que lo ve igual la IA que edita (get_manifest) que la app (fase 7). Ver
// docs/decision-animacion.md §9. Los textos van en inglés: los lee la IA de una app, y la app suele ser en inglés.

import { buscar } from './documento.js';
import { leer, leerMeta } from './esquema.js';
import { clipsDisparables, esBase } from './vivo.js';

const objetosDePose = (doc, id) => Object.keys(buscar(doc, id)?.values ?? {});

/** Las poses que mueve un param (por sus drivers), con los objetos que toca cada una. */
function posesDeParam(doc, param) {
  return doc.objects
    .filter((d) => d.type === 'driver' && d.param === param && buscar(doc, d.pose)?.type === 'pose')
    .map((d) => ({ pose: d.pose, ...(d.equals != null ? { when: d.equals } : {}), objects: objetosDePose(doc, d.pose) }));
}

/** Qué anima un clip: objetos (sin repetir) y params. */
function queAnima(doc, clip) {
  const ids = Object.keys(clip.tracks ?? {});
  return {
    objects: ids.filter((id) => buscar(doc, id) && buscar(doc, id).type !== 'param'),
    params: ids.filter((id) => buscar(doc, id)?.type === 'param'),
  };
}

/**
 * El manifiesto como objeto: { name, api, params, clips, auto }. `clips` son los que la app puede disparar (base o
 * gesto); `auto` los que suenan solos (solo informativos).
 */
export function manifiesto(doc, esquema) {
  const params = doc.objects
    .filter((o) => o.type === 'param')
    .map((p) => {
      const kind = leer(esquema, p, 'kind');
      const base = { id: p.id, kind, description: leer(esquema, p, 'description') };
      if (kind === 'enum') Object.assign(base, { options: leer(esquema, p, 'options'), initial: leer(esquema, p, 'initial') ?? leer(esquema, p, 'options')[0] ?? null });
      else if (kind === 'boolean') base.initial = leer(esquema, p, 'default') >= 0.5;
      else Object.assign(base, { min: leer(esquema, p, 'min'), max: leer(esquema, p, 'max'), initial: leer(esquema, p, 'default') });
      return { ...base, moves: posesDeParam(doc, p.id) };
    });
  const clips = clipsDisparables(doc, esquema).map((c) => {
    const anima = queAnima(doc, c);
    const next = leer(esquema, c, 'next');
    return {
      id: c.id,
      role: esBase(esquema, c) ? 'base' : 'gesture',
      description: leer(esquema, c, 'description'),
      duration: leer(esquema, c, 'duration'),
      loop: leer(esquema, c, 'loop'),
      ...(next ? { next } : {}),
      ...(leer(esquema, c, 'blend') === 'additive' ? { blend: 'additive' } : {}),
      animates: anima.objects,
      ...(anima.params.length ? { animatesParams: anima.params } : {}),
    };
  });
  const auto = doc.objects
    .filter((o) => o.type === 'animation' && leer(esquema, o, 'usage') === 'puppet' && leer(esquema, o, 'auto') !== 'off')
    .map((c) => ({
      id: c.id,
      auto: leer(esquema, c, 'auto'),
      ...(leer(esquema, c, 'auto') === 'repeat' ? { every: [leer(esquema, c, 'repeat_min'), leer(esquema, c, 'repeat_max')] } : {}),
      description: leer(esquema, c, 'description'),
      animates: queAnima(doc, c).objects,
    }));
  return {
    name: leerMeta(esquema, doc, 'name'),
    api: {
      play: 'play(clip): a base clip (loop) replaces the current base with a crossfade; a gesture (once) plays on top of it and fades out by itself at the end (then its next, if any).',
      set: 'set(param, value): sets a parameter. While a clip animates that parameter, the clip wins; when it fades out, the value goes back to yours.',
      stop: 'stop(clip) fades a clip out; stop() fades out everything the app played. Auto clips keep playing.',
    },
    params,
    clips,
    auto,
  };
}

/** El manifiesto como texto corto, para leerlo de un vistazo (la IA que edita y las pruebas). */
export function textoDeManifiesto(m) {
  const lineas = [`Puppet "${m.name}". API: play(clip), set(param, value), stop(clip?).`];
  lineas.push('', 'Params:');
  if (!m.params.length) lineas.push('- (none)');
  for (const p of m.params) {
    const rango = p.kind === 'enum' ? `one of ${p.options.join(' | ')}` : p.kind === 'boolean' ? 'true/false' : `${p.min}…${p.max}`;
    const mueve = p.moves.length ? ` → ${p.moves.map((x) => `${x.pose}${x.when != null ? ` (= ${x.when})` : ''}`).join(', ')}` : ' → moves nothing (no driver)';
    lineas.push(`- ${p.id} (${rango}, initial ${p.initial})${p.description ? `: ${p.description}` : ' — no description'}${mueve}`);
  }
  lineas.push('', 'Clips (play them):');
  if (!m.clips.length) lineas.push('- (none)');
  for (const c of m.clips) {
    const extra = [c.role, `${c.duration} s`, c.loop, c.next && `then ${c.next}`, c.blend].filter(Boolean).join(', ');
    lineas.push(`- ${c.id} (${extra})${c.description ? `: ${c.description}` : ' — no description'}`);
  }
  if (m.auto.length) {
    lineas.push('', 'Automatic (they play by themselves):');
    for (const a of m.auto) lineas.push(`- ${a.id} (${a.auto}${a.every ? ` every ${a.every[0]}–${a.every[1]} s` : ''})${a.description ? `: ${a.description}` : ''}`);
  }
  return lineas.join('\n');
}
