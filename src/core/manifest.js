// The manifest: what the app's AI knows about the puppet to drive it live (play, set, stop). It comes from the
// document and nothing else, so the editing AI (get_manifest) sees it the same as the app (phase 7). See
// docs/decision-animacion.md §9. The texts are in English: an app's AI reads them, and the app is usually in English.

import { findObject } from './document.js';
import { read, readMeta } from './schema.js';
import { triggerableClips, isBase } from './live.js';

const poseObjects = (doc, id) => Object.keys(findObject(doc, id)?.values ?? {});

/** The poses a param moves (through its drivers), with the objects each one touches. */
function paramPoses(doc, param) {
  return doc.objects
    .filter((d) => d.type === 'driver' && d.param === param && findObject(doc, d.pose)?.type === 'pose')
    .map((d) => ({ pose: d.pose, ...(d.equals != null ? { when: d.equals } : {}), objects: poseObjects(doc, d.pose) }));
}

/** What a clip animates: objects (without repeats) and params. */
function thatAnimates(doc, clip) {
  const ids = Object.keys(clip.tracks ?? {});
  return {
    objects: ids.filter((id) => findObject(doc, id) && findObject(doc, id).type !== 'param'),
    params: ids.filter((id) => findObject(doc, id)?.type === 'param'),
  };
}

/**
 * The manifest as an object: { name, api, params, clips, auto }. `clips` are the ones the app can trigger (base or
 * gesture); `auto` the ones that play on their own (informative only).
 */
export function manifest(doc, schema) {
  const params = doc.objects
    .filter((o) => o.type === 'param')
    .map((p) => {
      const kind = read(schema, p, 'kind');
      const base = { id: p.id, kind, description: read(schema, p, 'description') };
      if (kind === 'enum') Object.assign(base, { options: read(schema, p, 'options'), initial: read(schema, p, 'initial') ?? read(schema, p, 'options')[0] ?? null });
      else if (kind === 'boolean') base.initial = read(schema, p, 'default') >= 0.5;
      else Object.assign(base, { min: read(schema, p, 'min'), max: read(schema, p, 'max'), initial: read(schema, p, 'default') });
      return { ...base, moves: paramPoses(doc, p.id) };
    });
  const autos = doc.objects.filter((o) => o.type === 'animation' && read(schema, o, 'usage') === 'puppet' && read(schema, o, 'auto') !== 'off');
  // A param animated by an auto clip is driven by the puppet itself: if the app sets it, the auto overrides it when
// it plays.
  for (const p of params) {
    const drivenBy = autos.filter((c) => thatAnimates(doc, c).params.includes(p.id)).map((c) => c.id);
    if (drivenBy.length) p.drivenBy = drivenBy;
  }
  const clips = triggerableClips(doc, schema).map((c) => {
    const animates = thatAnimates(doc, c);
    const next = read(schema, c, 'next');
    return {
      id: c.id,
      role: isBase(schema, c) ? 'base' : 'gesture',
      description: read(schema, c, 'description'),
      duration: read(schema, c, 'duration'),
      loop: read(schema, c, 'loop'),
      fade: read(schema, c, 'fade'),
      ...(next ? { next } : {}),
      ...(read(schema, c, 'blend') === 'additive' ? { blend: 'additive' } : {}),
      animates: animates.objects,
      ...(animates.params.length ? { animatesParams: animates.params } : {}),
    };
  });
  const auto = autos.map((c) => {
    const animates = thatAnimates(doc, c);
    return {
      id: c.id,
      auto: read(schema, c, 'auto'),
      ...(read(schema, c, 'auto') === 'repeat' ? { every: [read(schema, c, 'repeat_min'), read(schema, c, 'repeat_max')] } : {}),
      ...(read(schema, c, 'blend') === 'additive' ? { blend: 'additive' } : {}),
      description: read(schema, c, 'description'),
      animates: animates.objects,
      ...(animates.params.length ? { animatesParams: animates.params } : {}),
    };
  });
  // What would confuse the app's AI: empty descriptions and params that move nothing.
  const problems = [];
  const withoutDescription = (list) => list.filter((x) => !x.description).map((x) => x.id);
  if (withoutDescription(params).length) problems.push(`params without description: ${withoutDescription(params).join(', ')}`);
  if (withoutDescription(clips).length) problems.push(`clips without description: ${withoutDescription(clips).join(', ')}`);
  const still = params.filter((p) => !p.moves.length && !clips.some((c) => c.animatesParams?.includes(p.id))).map((p) => p.id);
  if (still.length) problems.push(`params that move nothing (no driver): ${still.join(', ')}`);
  return {
    name: readMeta(schema, doc, 'name'),
    api: {
      play: 'play(clip): a base clip (loop) replaces the current base with a crossfade; a gesture (once) plays on top of it and fades out by itself at the end (then its next, if any).',
      set: 'set(param, value): sets a parameter. While a clip animates that parameter, the clip wins; when it fades out, the value goes back to yours.',
      stop: 'stop(clip) fades a clip out; stop() fades out everything the app played. Auto clips keep playing.',
    },
    params,
    clips,
    auto,
    problems,
  };
}

/** A short list for the text: up to 6 ids and «…» if there are more. */
const short = (ids) => (ids.length > 6 ? `${ids.slice(0, 6).join(', ')}… (${ids.length})` : ids.join(', '));

/** The manifest as short text, to read at a glance (the editing AI and the tests). */
export function manifestText(m) {
  const lines = [`Puppet "${m.name}". API: play(clip), set(param, value), stop(clip?).`];
  lines.push('', 'Params:');
  if (!m.params.length) lines.push('- (none)');
  for (const p of m.params) {
    const range = p.kind === 'enum' ? `one of ${p.options.join(' | ')}` : p.kind === 'boolean' ? 'true/false' : `${p.min}…${p.max}`;
    const moves = p.moves.length ? ` → ${p.moves.map((x) => `${x.pose}${x.when != null ? ` (= ${x.when})` : ''}`).join(', ')}` : ' → moves nothing (no driver)';
    const auto = p.drivenBy ? ` [driven by auto ${p.drivenBy.join(', ')}: don't set it]` : '';
    lines.push(`- ${p.id} (${range}, initial ${p.initial})${p.description ? `: ${p.description}` : ' — no description'}${moves}${auto}`);
  }
  lines.push('', 'Clips (play them):');
  if (!m.clips.length) lines.push('- (none)');
  for (const c of m.clips) {
    const extra = [c.role, `${c.duration} s`, c.loop, `fade ${c.fade} s`, c.next && `then ${c.next}`, c.blend].filter(Boolean).join(', ');
    lines.push(`- ${c.id} (${extra})${c.description ? `: ${c.description}` : ' — no description'}`);
    // What overrides: two gestures that touch the same thing hide each other; a clip that animates a param beats the
// app while it plays.
    const overwrites = [c.animatesParams?.length && `params ${c.animatesParams.join(', ')}`, c.animates.length && short(c.animates)].filter(Boolean).join('; ');
    if (overwrites) lines.push(`    overrides: ${overwrites}`);
  }
  if (m.auto.length) {
    lines.push('', 'Automatic (they play by themselves):');
    for (const a of m.auto) {
      const overwrites = [a.animatesParams?.length && `params ${a.animatesParams.join(', ')}`, a.animates.length && short(a.animates)].filter(Boolean).join('; ');
      lines.push(`- ${a.id} (${a.auto}${a.every ? ` every ${a.every[0]}–${a.every[1]} s` : ''}${a.blend ? `, ${a.blend}` : ''})${a.description ? `: ${a.description}` : ''}${overwrites ? ` — ${overwrites}` : ''}`);
    }
  }
  if (m.problems.length) {
    lines.push('', 'Problems for the app’s AI:');
    for (const p of m.problems) lines.push(`- ${p}`);
  }
  return lines.join('\n');
}
