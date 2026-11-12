// Modos del editor (Design · Animate · Puppet), la timeline de abajo y la biblioteca de clips de Puppet. Ver
// docs/decision-animacion.md.
//
// Un clip abierto se edita como una pose (estado.pose = id del clip): lo que se cambia en el lienzo o en el inspector
// queda como keyframe en el tiempo del playhead (autokey, ver opsDePose en huesos.js).

import { ICONOS } from './iconos.js';
import { avisosDeClip, escalarTiempo, esEscena, moverClave, ponerClave, quitarClave, redondearTiempo, tiempoLocal, tiemposDeClaves, valorAGuardar, valoresDeMontaje } from '../core/animacion.js';
import { NOMBRES_DE_CURVA, aplicarCurva, errorDeCurva, mismoTiempo } from '../core/curvas.js';
import { buscar, subarbol } from '../core/documento.js';
import { leer, leerMeta } from '../core/esquema.js';
import { valorEfectivo } from '../core/estilos.js';
import { avisar, ejecutar, esquema, estado, fijar, previsualizar, seleccionar, seleccionarVarios, suscribir } from './estado.js';
import { clipAbierto, poseActiva } from './huesos.js';
import { alternarLive, dispararClip } from './vivo.js';

const MODOS = {
  design: 'Design: draw and rig the character (the setup).',
  animate: 'Animate: a scene timeline, to export as video, Lottie or SVG.',
  puppet: 'Puppet: the controls an app or its AI uses live (parameters, poses and clips).',
};

const n = (t) => +t.toFixed(3);
const idDesde = (texto, prefijo) => {
  const base = texto?.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return base ? (/^[a-z]/.test(base) ? base : `${prefijo}_${base}`) : null;
};

/** Crea un clip nuevo (pide el nombre) y lo abre. */
function nuevoClip(usage) {
  if (!estado.doc) return;
  const id = idDesde(prompt(usage === 'puppet' ? 'Clip name (e.g. wave, blink, idle):' : 'Scene name (e.g. intro, scene_1):', ''), 'clip');
  if (!id) return;
  if (buscar(estado.doc, id)) return avisar(`"${id}" already exists`, true);
  ejecutar([{ op: 'create', type: 'animation', id, props: { usage, duration: usage === 'puppet' ? 1 : 5 } }], `create ${usage === 'puppet' ? 'clip' : 'scene'} ${id}`);
  abrirClip(id);
}

function abrirClip(id) {
  detener();
  fijar({ pose: id, tiempo: 0, edicion: null, vertice: null });
}

// ---------- Reproducción ----------

let cuadro = null;
function reproducir() {
  const clip = clipAbierto();
  if (!clip) return;
  const duracion = leer(esquema, clip, 'duration');
  const desde = estado.tiempo >= duracion - 1e-6 && leer(esquema, clip, 'loop') === 'once' ? 0 : estado.tiempo;
  const inicio = performance.now();
  fijar({ reproduciendo: true });
  const paso = (ahora) => {
    const c = clipAbierto();
    if (!c || !estado.reproduciendo) return detener();
    const t = desde + (ahora - inicio) / 1000;
    if (leer(esquema, c, 'loop') === 'once' && t >= leer(esquema, c, 'duration')) {
      fijar({ tiempo: leer(esquema, c, 'duration') });
      return detener();
    }
    fijar({ tiempo: tiempoLocal(esquema, c, t) });
    cuadro = requestAnimationFrame(paso);
  };
  cuadro = requestAnimationFrame(paso);
}
function detener() {
  cancelAnimationFrame(cuadro);
  if (estado.reproduciendo) fijar({ reproduciendo: false });
}

// ---------- Modos ----------

export function montarModos(botones) {
  for (const b of botones.querySelectorAll('[data-modo]')) {
    b.title = MODOS[b.dataset.modo];
    b.addEventListener('click', () => cambiarModo(b.dataset.modo));
  }
  suscribir((c) => {
    if (!('modo' in c) && !('id' in c)) return;
    document.body.dataset.modo = estado.modo;
    for (const b of botones.querySelectorAll('[data-modo]')) b.setAttribute('aria-selected', String(b.dataset.modo === estado.modo));
  });
  document.body.dataset.modo = estado.modo;
}

export function cambiarModo(modo) {
  detener();
  const doc = estado.doc;
  if (modo === 'design') return fijar({ modo, pose: null, params: null, edicion: null, vertice: null });
  if (modo === 'animate') {
    // Se abre la primera escena, si hay.
    const escena = doc?.objects.find((o) => o.type === 'animation' && leer(esquema, o, 'usage') === 'animate');
    return fijar({ modo, pose: escena?.id ?? null, params: null, tiempo: 0, edicion: null, vertice: null });
  }
  // Puppet: se ve la mezcla de los params; los clips se abren desde la biblioteca de la derecha.
  fijar({ modo, pose: null, params: estado.params ?? {}, tiempo: 0, edicion: null, vertice: null });
}

// ---------- Biblioteca de clips (Puppet) ----------

/** Cómo suena un clip en vivo, en pocas palabras: «base», «gesture», «auto: every 2–6 s», «auto: always». */
function papelEnVivo(clip) {
  const auto = leer(esquema, clip, 'auto');
  if (auto === 'repeat') return `auto · every ${n(leer(esquema, clip, 'repeat_min'))}–${n(leer(esquema, clip, 'repeat_max'))} s`;
  if (auto === 'always') return 'auto · always';
  return leer(esquema, clip, 'loop') === 'once' ? 'gesture' : 'base';
}

export function montarClips(raiz, lista, botonNuevo, botonLive) {
  botonNuevo.addEventListener('click', () => nuevoClip('puppet'));
  botonLive.addEventListener('click', () => {
    detener();
    alternarLive();
  });
  suscribir((c) => {
    if ('doc' in c || 'pose' in c || 'modo' in c || 'id' in c || 'reproduciendo' in c || 'vivo' in c) dibujar();
    else if ('estadoVivo' in c) actualizarVivo();
  });

  function dibujar() {
    const doc = estado.doc;
    raiz.hidden = estado.modo !== 'puppet' || !doc;
    raiz.classList.toggle('en-vivo', estado.vivo);
    botonLive.textContent = estado.vivo ? '■ Live' : '▶ Live';
    botonLive.setAttribute('aria-pressed', String(estado.vivo));
    botonLive.title = estado.vivo
      ? 'Stop Live and go back to editing'
      : 'Live: play the puppet as the app will. Clip buttons trigger clips (with fades), Parameters are the app’s values, and nothing is saved.';
    botonNuevo.disabled = estado.vivo;
    if (raiz.hidden) return;
    const clips = doc.objects.filter((o) => o.type === 'animation' && leer(esquema, o, 'usage') === 'puppet');
    if (!clips.length) {
      lista.innerHTML = '<p class="ayuda">No clips yet. A clip is a short animation the app or its AI triggers (wave, blink, idle). Create one with “＋ Clip”.</p>';
      return;
    }
    lista.replaceChildren(...clips.map((clip) => (estado.vivo ? filaEnVivo(clip) : filaParaEditar(clip))));
    if (estado.vivo) actualizarVivo();
  }

  function filaParaEditar(clip) {
    const abierto = estado.pose === clip.id;
    const fila = document.createElement('div');
    fila.className = `clip${abierto ? ' abierto' : ''}`;
    const boton = Object.assign(document.createElement('button'), { type: 'button', className: 'nombre' });
    const descripcion = leer(esquema, clip, 'description');
    boton.innerHTML = `<b></b><small></small>`;
    boton.querySelector('b').textContent = clip.id;
    boton.querySelector('small').textContent = `${n(leer(esquema, clip, 'duration'))} s · ${leer(esquema, clip, 'loop')}`;
    boton.title = `${descripcion ? `${descripcion}\n` : ''}${papelEnVivo(clip)}. Click to edit it in the timeline`;
    boton.addEventListener('click', () => (abierto ? fijar({ pose: null, params: estado.params ?? {} }) : abrirClip(clip.id)));
    const play = Object.assign(document.createElement('button'), { type: 'button', className: 'play', textContent: abierto && estado.reproduciendo ? '■' : '▶' });
    play.title = abierto && estado.reproduciendo ? 'Stop' : 'Play the clip';
    play.addEventListener('click', () => {
      if (abierto && estado.reproduciendo) return detener();
      if (!abierto) abrirClip(clip.id);
      reproducir();
    });
    fila.append(boton, play);
    return fila;
  }

  /** Con Live: el botón dispara el clip (los auto suenan solos); ■ lo saca. La barra de abajo es su peso. */
  function filaEnVivo(clip) {
    const auto = leer(esquema, clip, 'auto') !== 'off';
    const fila = document.createElement('div');
    fila.className = `clip vivo${auto ? ' auto' : ''}`;
    fila.dataset.clip = clip.id;
    const boton = Object.assign(document.createElement('button'), { type: 'button', className: 'nombre', disabled: auto });
    const descripcion = leer(esquema, clip, 'description');
    boton.innerHTML = `<b></b><small></small><span class="peso"></span>`;
    boton.querySelector('b').textContent = clip.id;
    boton.querySelector('small').textContent = papelEnVivo(clip);
    boton.title = `${descripcion ? `${descripcion}\n` : ''}${auto ? 'Plays by itself (auto)' : leer(esquema, clip, 'loop') === 'once' ? 'Click: play this gesture on top of the base' : 'Click: make this the base (crossfade)'}`;
    boton.addEventListener('click', () => dispararClip(clip.id));
    const parar = Object.assign(document.createElement('button'), { type: 'button', className: 'play', textContent: '■', title: 'Fade this clip out', disabled: true });
    parar.addEventListener('click', () => dispararClip(clip.id, { parar: true }));
    if (auto) parar.hidden = true;
    fila.append(boton, parar);
    return fila;
  }

  /** Cada cuadro: el peso de cada clip que suena, sin rehacer los botones (un clic no se perdería a mitad). */
  function actualizarVivo() {
    const sonando = estado.estadoVivo?.sonando ?? [];
    for (const fila of lista.querySelectorAll('.clip.vivo')) {
      const s = sonando.filter((x) => x.clip === fila.dataset.clip);
      const peso = Math.max(0, ...s.map((x) => x.peso));
      fila.style.setProperty('--peso', `${Math.round(peso * 100)}%`);
      fila.classList.toggle('sonando', peso > 0);
      const parar = fila.querySelector('.play');
      parar.disabled = !s.some((x) => !x.saliendo && x.capa !== 'auto');
    }
  }
}

// ---------- Timeline ----------

export function montarTimeline(raiz) {
  // Keyframe elegido: { id, prop, t } (solo del editor).
  let elegida = null;
  // Grupos de la timeline abiertos o cerrados a mano (id → true/false); si no se tocó, solo el principal va abierto.
  const plegados = new Map();
  // «Scale keys» al cambiar Length: se recuerda mientras el editor está abierto.
  let escalarClaves = false;
  raiz.tabIndex = -1;

  suscribir((c) => {
    if ('vivo' in c || (estado.vivo && 'estadoVivo' in c)) return dibujar();
    if (estado.vivo) return;
    if ('doc' in c || 'previa' in c || 'pose' in c || 'modo' in c || 'id' in c || 'seleccion' in c || 'reproduciendo' in c) dibujar();
    else if ('tiempo' in c) moverPlayhead();
  });

  const clipVisible = () => clipAbierto(estado.previa ?? estado.doc);
  const fps = () => leerMeta(esquema, estado.doc, 'fps');
  const ajustarACuadro = (t) => redondearTiempo(Math.round(t * fps()) / fps());

  function dibujar() {
    const doc = estado.doc;
    if (!doc) return raiz.replaceChildren();
    if (estado.vivo) return raiz.replaceChildren(enVivo(doc));
    const clip = clipVisible();
    if (elegida && !clavesEn(clip, elegida.id, elegida.props, elegida.t).length) elegida = null;
    raiz.replaceChildren(barra(doc, clip), clip ? pistas(clip) : vacio());
    moverPlayhead();
  }

  /**
   * Con Live encendido, la timeline muestra qué suena: una fila por clip (base, gestos, auto) con su peso (la barra) y
   * por dónde va (la marca). Se rehace en cada cuadro; no tiene nada que se pueda tocar.
   */
  function enVivo(doc) {
    const caja = document.createElement('div');
    caja.className = 'tiempo-vivo';
    const titulo = document.createElement('p');
    titulo.className = 'ayuda';
    titulo.textContent = 'Live: what the app sees. Click clips on the right to play them, move Parameters, ■ Live to edit again.';
    caja.append(titulo);
    const sonando = estado.estadoVivo?.sonando ?? [];
    const nombres = { base: 'base', gesto: 'gesture', auto: 'auto' };
    for (const s of sonando) {
      const clip = buscar(doc, s.clip);
      if (!clip) continue;
      const d = leer(esquema, clip, 'duration');
      const avance = Math.min(1, tiempoLocal(esquema, clip, s.t) / d);
      const fila = document.createElement('div');
      fila.className = `fila-vivo capa-${s.capa}${s.saliendo ? ' saliendo' : ''}`;
      fila.innerHTML = '<span class="nombre"></span><span class="capa"></span><span class="barra"><span class="lleno"></span><span class="avance"></span></span><span class="valor"></span>';
      fila.querySelector('.nombre').textContent = s.clip;
      fila.querySelector('.capa').textContent = `${nombres[s.capa]}${s.saliendo ? ' · out' : ''}`;
      fila.querySelector('.lleno').style.width = `${Math.round(s.peso * 100)}%`;
      fila.querySelector('.avance').style.left = `${avance * 100}%`;
      fila.querySelector('.valor').textContent = `${Math.round(s.peso * 100)}%`;
      fila.title = `${s.clip}: weight ${Math.round(s.peso * 100)}%, at ${n(tiempoLocal(esquema, clip, s.t))} of ${n(d)} s`;
      caja.append(fila);
    }
    if (!sonando.length) {
      const p = document.createElement('p');
      p.className = 'ayuda';
      p.textContent = 'Nothing is playing: the setup with the parameters. Click a base clip (loop) to start.';
      caja.append(p);
    }
    return caja;
  }

  function vacio() {
    const p = document.createElement('p');
    p.className = 'ayuda';
    p.innerHTML =
      estado.modo === 'animate'
        ? 'No scene yet. Create one with + (above): then move the playhead and change things on the canvas or in the inspector — each change is keyed at the playhead.'
        : 'Pick a clip on the right (or create one with + above) to edit its keyframes here.';
    return p;
  }

  /**
   * Arriba, las pestañas como las de los documentos: en Animate, una por escena (× la borra, se puede deshacer); en
   * Puppet, el clip abierto (× lo cierra). El + crea una escena o un clip.
   */
  function pestanas(doc, clip) {
    const fila = document.createElement('div');
    fila.className = 'pestanas-tiempo';
    fila.setAttribute('role', 'tablist');
    const animate = estado.modo === 'animate';
    const lista = animate ? doc.objects.filter((o) => o.type === 'animation' && leer(esquema, o, 'usage') === 'animate') : clip ? [clip] : [];
    for (const c of lista) {
      const activa = c.id === clip?.id;
      const p = document.createElement('div');
      p.className = `pestana${activa ? ' activa' : ''}`;
      p.setAttribute('role', 'tab');
      p.setAttribute('aria-selected', String(activa));
      p.title = leer(esquema, c, 'description') || c.id;
      const cerrarTitulo = animate ? 'Delete this scene (undo brings it back)' : 'Close the clip';
      p.innerHTML = `<span class="titulo"></span><button type="button" class="cerrar" title="${cerrarTitulo}">×</button>`;
      p.querySelector('.titulo').textContent = c.id;
      p.addEventListener('click', (e) => {
        if (!e.target.closest('.cerrar')) return activa || abrirClip(c.id);
        if (!animate) return cerrarClip();
        if (!confirm(`Delete scene "${c.id}" and all its keyframes?`)) return;
        detener();
        const otra = lista.find((o) => o.id !== c.id);
        ejecutar([{ op: 'delete', target: c.id }], `delete scene ${c.id}`);
        if (activa) fijar({ pose: otra?.id ?? null, tiempo: 0 });
      });
      fila.append(p);
    }
    const nueva = Object.assign(document.createElement('button'), { type: 'button', className: 'nueva-pestana', title: animate ? 'New scene' : 'New clip', innerHTML: ICONOS.agregar });
    nueva.setAttribute('aria-label', nueva.title);
    nueva.addEventListener('click', () => nuevoClip(animate ? 'animate' : 'puppet'));
    fila.append(nueva);
    return fila;
  }

  function cerrarClip() {
    detener();
    fijar({ pose: null, params: estado.params ?? {} });
  }

  /** « y »: el keyframe anterior o siguiente del clip (o el principio y el final, si no hay más). */
  function saltar(clip, direccion) {
    detener();
    const tiempos = tiemposDeClaves(clip).filter((t) => !mismoTiempo(t, estado.tiempo) && (direccion < 0 ? t < estado.tiempo : t > estado.tiempo));
    const t = direccion < 0 ? (tiempos.at(-1) ?? 0) : (tiempos[0] ?? leer(esquema, clip, 'duration'));
    fijar({ tiempo: t });
  }

  function barra(doc, clip) {
    const contenedor = document.createElement('div');
    contenedor.className = 'cabeza-tiempo';
    contenedor.append(pestanas(doc, clip));
    if (!clip) return contenedor;
    const fila = document.createElement('div');
    fila.className = 'barra-tiempo';
    const izquierda = document.createElement('div');
    izquierda.className = 'zona izquierda';
    const centro = document.createElement('div');
    centro.className = 'zona centro';
    const div = document.createElement('div');
    div.className = 'zona derecha';
    fila.append(izquierda, centro, div);
    contenedor.append(fila);

    const duracion = leer(esquema, clip, 'duration');
    centro.append(
      boton('«', 'Previous keyframe (or the start)', () => saltar(clip, -1)),
      boton(estado.reproduciendo ? '⏸' : '▶', estado.reproduciendo ? 'Pause' : 'Play', () => (estado.reproduciendo ? detener() : reproducir()), 'play'),
      boton('»', 'Next keyframe (or the end)', () => saltar(clip, 1)),
    );
    izquierda.append(Object.assign(document.createElement('span'), { className: 'reloj' }));

    const campoDuracion = Object.assign(document.createElement('input'), { type: 'number', min: 0.05, step: 0.1, value: n(duracion), title: 'Duration in seconds' });
    campoDuracion.addEventListener('change', () => {
      const v = Number(campoDuracion.value);
      if (!(v > 0)) return dibujar();
      // Con «Scale keys», los keyframes se estiran o comprimen en proporción (lo mismo que scale_time del MCP).
      if (escalarClaves && tiemposDeClaves(clip).length) {
        let escalado;
        try {
          escalado = escalarTiempo(clip.tracks, duracion, { largo: v });
        } catch (error) {
          avisar(error.message, true);
          return dibujar();
        }
        ejecutar([{ op: 'set', target: clip.id, props: { tracks: escalado.pistas, duration: escalado.duracion } }], `scale time of ${clip.id}: ${n(duracion)} → ${n(v)} s`);
        fijar({ tiempo: redondearTiempo(Math.min(v, (estado.tiempo * v) / duracion)) });
        return;
      }
      const ultima = Math.max(0, ...Object.values(clip.tracks ?? {}).flatMap((c) => Object.values(c).flatMap((k) => k.map((x) => x.t))));
      if (v < ultima) {
        avisar(`There are keyframes up to ${n(ultima)} s: tick Scale keys to squeeze them into ${n(v)} s, or move or delete them first`, true);
        return dibujar();
      }
      ejecutar([{ op: 'set', target: clip.id, props: { duration: v } }], `${clip.id} duration ${v} s`);
      if (estado.tiempo > v) fijar({ tiempo: v });
    });
    const etiquetaDuracion = Object.assign(document.createElement('label'), { className: 'campo-corto', textContent: 'Length' });
    etiquetaDuracion.append(campoDuracion, document.createTextNode('s'));
    const escalar = Object.assign(document.createElement('input'), { type: 'checkbox', checked: escalarClaves });
    escalar.addEventListener('change', () => (escalarClaves = escalar.checked));
    const etiquetaEscalar = Object.assign(document.createElement('label'), { className: 'campo-corto', title: 'When on, changing Length stretches or squeezes every keyframe in proportion (one undo step)' });
    etiquetaEscalar.append(escalar, document.createTextNode('Scale keys'));

    const loop = document.createElement('select');
    loop.title = 'once: plays once and holds the end · loop: starts over · pingpong: back and forth';
    for (const v of ['once', 'loop', 'pingpong']) loop.append(new Option(v, v, false, v === leer(esquema, clip, 'loop')));
    loop.addEventListener('change', () => ejecutar([{ op: 'set', target: clip.id, props: { loop: loop.value } }], `${clip.id} loop ${loop.value}`));

    izquierda.append(etiquetaDuracion, etiquetaEscalar, loop);
    div.append(boton('◆ Key', 'Key the selected object at the playhead: its animated properties (or, if it has none, its rotation and position)', () => clavarSeleccion(clip)));

    // Una pose entera como keyframes en el playhead, y volver al montaje (lo mismo que pose y setup en set_keys).
    const poses = doc.objects.filter((o) => o.type === 'pose');
    if (poses.length) {
      const conPose = document.createElement('select');
      conPose.title = 'Key the values of a pose at the playhead: all of it, or only what is selected (like pose with only in set_keys)';
      conPose.append(new Option('◆ Pose…', ''), ...poses.map((p) => new Option(p.id, p.id)));
      // Lo seleccionado y lo que cuelga de ello (un grupo o un skeleton valen por sus partes).
      const elegidos = new Set(estado.seleccionados.flatMap((id) => subarbol(estado.doc, id)));
      const parciales = poses.filter((p) => Object.keys(p.values ?? {}).some((id) => elegidos.has(id)));
      if (parciales.length) {
        const grupo = Object.assign(document.createElement('optgroup'), { label: 'Only the selection' });
        grupo.append(...parciales.map((p) => new Option(`${p.id} (selection)`, `sel:${p.id}`)));
        conPose.append(grupo);
      }
      conPose.addEventListener('change', () => {
        if (!conPose.value) return;
        const soloSeleccion = conPose.value.startsWith('sel:');
        const id = conPose.value.replace(/^sel:/, '');
        const valores = structuredClone(buscar(estado.doc, id).values ?? {});
        if (soloSeleccion) for (const objeto of Object.keys(valores)) if (!elegidos.has(objeto)) delete valores[objeto];
        clavarValores(clip, valores, soloSeleccion ? `pose ${id} (only ${Object.keys(valores).join(', ')})` : `pose ${id}`, false);
      });
      div.append(conPose);
    }
    const ayudaSetup = esEscena(esquema, clip)
      ? 'Key the setup values (the rest pose) of everything this scene animates at the playhead'
      : 'Key the setup values (the rest pose) of everything this clip animates at the playhead, and its parameters at their initial value';
    div.append(boton('◆ Setup', ayudaSetup, () => {
      const valores = valoresDeMontaje(estado.doc, esquema, clip.tracks);
      if (!Object.keys(valores).length) return avisar('This clip animates nothing yet: key something first', true);
      clavarValores(clip, valores, 'setup', false);
    }));

    // Drivers que suman encima de pistas del clip (lo mismo que avisan set_keys y render_preview a la IA).
    const avisos = avisosDeClip(doc, esquema, clip, estado.params ?? {});
    if (avisos.length) div.append(Object.assign(document.createElement('span'), { className: 'aviso-drivers', textContent: `⚠ ${avisos.length} driver${avisos.length > 1 ? 's' : ''} add on top`, title: avisos.join('\n') }));

    // Curva y borrar del keyframe elegido (en todas las propiedades de su canal que tienen keyframe ahí).
    if (elegida) {
      const claves = clavesEn(clip, elegida.id, elegida.props, elegida.t);
      const curvas = [...new Set(claves.map(([, c]) => JSON.stringify(c.ease ?? 'linear')))];
      const primera = claves[0][1].ease;
      const curva = document.createElement('select');
      curva.title = 'Ease of the segment that leaves this keyframe';
      const actual = curvas.length > 1 ? 'mixed' : Array.isArray(primera) ? 'custom' : (primera ?? 'linear');
      if (actual === 'mixed') curva.append(new Option('(mixed)', 'mixed', false, true));
      for (const v of NOMBRES_DE_CURVA) curva.append(new Option(v, v, false, v === actual));
      if (actual === 'custom') curva.append(new Option(`cubic-bezier(${primera.join(', ')})`, 'custom', false, true));
      curva.append(new Option('cubic-bezier…', 'editar'));
      curva.addEventListener('change', () => {
        let ease = curva.value;
        if (ease === 'custom' || ease === 'mixed') return;
        if (ease === 'editar') {
          // Como en CSS: x1, y1, x2, y2 (x entre 0 y 1; y puede pasarse para un rebote).
          const previa = Array.isArray(primera) ? primera.join(', ') : '0.3, 1.6, 0.6, 1';
          const texto = prompt('cubic-bezier x1, y1, x2, y2 (as in CSS; y outside 0…1 overshoots):', previa);
          if (texto == null) return dibujar();
          ease = texto.split(/[\s,]+/).filter(Boolean).map(Number);
          const error = errorDeCurva(ease);
          if (error) {
            avisar(error, true);
            return dibujar();
          }
        }
        let tracks = clip.tracks;
        for (const [prop, c] of claves) tracks = ponerClave(tracks, elegida.id, prop, c.t, c.value, ease);
        ejecutar([{ op: 'set', target: clip.id, props: { tracks } }], `${clip.id}: ease ${Array.isArray(ease) ? `cubic-bezier(${ease.join(', ')})` : ease} at ${n(elegida.t)} s`);
      });
      const etiqueta = Object.assign(document.createElement('label'), { className: 'campo-corto', textContent: `${elegida.id} ${elegida.canal} @ ${n(elegida.t)} s` });
      etiqueta.append(curva);
      if (actual !== 'mixed') etiqueta.append(formaDeCurva(primera ?? 'linear'));
      div.append(etiqueta, boton('Delete key', 'Delete this keyframe (Del)', () => borrarElegida(clip)));
    }
    if (estado.modo === 'puppet') {
      const descripcion = Object.assign(document.createElement('input'), { type: 'text', className: 'descripcion', value: leer(esquema, clip, 'description'), placeholder: 'What it does (for the app’s AI)' });
      descripcion.addEventListener('change', () => ejecutar([{ op: 'set', target: clip.id, props: { description: descripcion.value } }], `${clip.id} description`));
      izquierda.append(descripcion);
    }
    return contenedor;
  }

  function boton(texto, titulo, accion, clase = '') {
    const b = Object.assign(document.createElement('button'), { type: 'button', textContent: texto, title: titulo, className: clase });
    b.addEventListener('click', accion);
    return b;
  }

  /** ◆ Key: los objetos seleccionados en el tiempo del playhead, cada uno con lo que tiene pista o, si no, rotación y posición. */
  function clavarSeleccion(clip) {
    const objs = objetosElegidos().filter((o) => o.type !== 'param');
    if (!objs.length) return avisar('Select objects or bones to key them', true);
    const pose = poseActiva();
    const valores = {};
    for (const obj of objs) {
      const props = esquema.tipos.get(obj.type).properties;
      let claves = Object.keys(clip.tracks?.[obj.id] ?? {});
      if (!claves.length) claves = (obj.type === 'bone' ? ['rotation'] : ['x', 'y', 'rotation']).filter((k) => props[k]?.animatable);
      if (claves.length) valores[obj.id] = Object.fromEntries(claves.map((k) => [k, pose?.values?.[obj.id]?.[k] ?? valorEfectivo(esquema, estado.doc, obj, k)]));
    }
    const ids = Object.keys(valores);
    if (!ids.length) return avisar(`${objs.map((o) => o.id).join(', ')}: nothing to key here; change a value in the inspector to key it`, true);
    clavarValores(clip, valores, ids.length === 1 ? ids[0] : `${ids.length} objects`);
  }

  /** Lo seleccionado que tiene canales (objetos, huesos y params; no recursos), en el orden en que se eligió. */
  function objetosElegidos() {
    // Los params son de Puppet: en una escena no tienen canal (pudieron quedar seleccionados al venir de Puppet).
    const params = !esEscena(esquema, clipVisible());
    return estado.seleccionados.map((id) => buscar(estado.doc, id)).filter((o) => o && (o.type === 'param' ? params : !esquema.tipos.get(o.type)?.resource));
  }

  /** Abierto o cerrado: lo que eligió el usuario o, si no lo tocó, abierto solo el principal (o el único). */
  function grupoAbierto(id, cuantos) {
    return plegados.has(id) ? plegados.get(id) : cuantos === 1 || id === estado.seleccion;
  }

  /**
   * Keyframes en el playhead con estos valores ({ objeto: { propiedad: valor } }; un param, { value }). Con `vistos`,
   * son lo que se ve y se les resta lo que suman los drivers; los de una pose o del montaje se guardan tal cual.
   */
  function clavarValores(clip, valores, que, vistos = true) {
    const params = estado.params ?? {};
    let tracks = clip.tracks ?? {};
    for (const [id, campos] of Object.entries(valores)) {
      for (const [k, v] of Object.entries(campos)) tracks = ponerClave(tracks, id, k, estado.tiempo, vistos ? valorAGuardar(estado.doc, esquema, clip, estado.tiempo, params, id, k, v) : v);
    }
    ejecutar([{ op: 'set', target: clip.id, props: { tracks } }], `${clip.id}: key ${que} at ${n(estado.tiempo)} s`);
  }

  /** Borra un canal entero (todos los keyframes de sus propiedades). */
  function borrarCanal(clip, id, canal) {
    const tracks = structuredClone(clip.tracks ?? {});
    for (const prop of canal.props) delete tracks[id]?.[prop];
    if (tracks[id] && !Object.keys(tracks[id]).length) delete tracks[id];
    ejecutar([{ op: 'set', target: clip.id, props: { tracks } }], `${clip.id}: delete ${id} ${canal.nombre} track`);
  }

  function borrarElegida(clip) {
    if (!elegida) return;
    let tracks = clip.tracks;
    for (const prop of elegida.props) tracks = quitarClave(tracks, elegida.id, prop, elegida.t);
    ejecutar([{ op: 'set', target: clip.id, props: { tracks } }], `${clip.id}: delete key ${elegida.id} ${elegida.canal} at ${n(elegida.t)} s`);
    elegida = null;
  }

  // Del borra el keyframe elegido mientras el foco está en la timeline (sin llegar al atajo de borrar objetos).
  raiz.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select')) return;
    const clip = clipAbierto();
    if ((e.key === 'Delete' || e.key === 'Backspace') && elegida && clip) {
      e.stopPropagation();
      borrarElegida(clip);
    }
  });

  /**
   * La regla, una fila con todos los keyframes del clip y, como en Moho, los canales de lo seleccionado: todos los
   * animables, también los que todavía no tienen keyframes (◇ los keya en el playhead).
   */
  function pistas(clip) {
    const duracion = leer(esquema, clip, 'duration');
    const cuerpo = document.createElement('div');
    cuerpo.className = 'pistas';
    const izquierda = (t) => `${(t / duracion) * 100}%`;

    const regla = document.createElement('div');
    regla.className = 'fila-pista regla';
    const carril = document.createElement('div');
    carril.className = 'carril';
    const pasoMarca = duracion > 20 ? 5 : duracion > 8 ? 2 : duracion > 3 ? 1 : duracion > 1 ? 0.5 : 0.25;
    for (let t = 0; t <= duracion + 1e-9; t += pasoMarca) {
      const marca = Object.assign(document.createElement('span'), { className: 'marca', textContent: `${n(t)}s` });
      marca.style.left = izquierda(t);
      carril.append(marca);
    }
    regla.append(Object.assign(document.createElement('span'), { className: 'etiqueta' }), carril);
    cuerpo.append(regla);

    // Todos los keyframes del clip, en gris: para ver el ritmo y saber dónde hay algo (clic = llevar el playhead ahí).
    const todos = fila('All keys', 'Every keyframe of the clip, of any object. Click one to move the playhead there.');
    todos.classList.add('resumen');
    for (const t of tiemposDeClaves(clip)) {
      const rombo = Object.assign(document.createElement('span'), { className: 'clave resumen', title: `Keyframes at ${n(t)} s. Click to go there; drag to move the whole moment (every keyframe at ${n(t)} s).` });
      rombo.style.left = izquierda(t);
      rombo.addEventListener('pointerdown', (e) => arrastrarMomento(e, clip, null, t, todos.carril));
      todos.carril.append(rombo);
    }
    cuerpo.append(todos);

    // Como en Rive: un grupo por cada cosa seleccionada (en Layers o en el lienzo), plegable; abierto, sus canales como en Moho.
    const objs = objetosElegidos().filter((o) => canalesDe(o).length);
    if (!objs.length) {
      // Sin selección: qué objetos tiene animados el clip, para ir a ellos.
      const ayuda = document.createElement('div');
      ayuda.className = 'ayuda-canales';
      const animados = Object.keys(clip.tracks ?? {}).filter((id) => buscar(estado.doc, id));
      ayuda.append(document.createTextNode(estado.seleccion ? `${estado.seleccion} has no animatable channels. ` : 'Select objects or bones (Ctrl + click in Layers adds more) to see their channels. '));
      if (animados.length) {
        ayuda.append(document.createTextNode('Animated: '));
        for (const id of animados) ayuda.append(boton(id, `Select ${id}`, () => seleccionar(id), 'chip'));
      }
      cuerpo.append(ayuda);
    }
    for (const obj of objs) {
      const canales = canalesDe(obj);
      const abierto = grupoAbierto(obj.id, objs.length);
      // La fila del objeto: ▸/▾ pliega, el nombre lo hace principal, y en el carril todos sus keyframes juntos.
      const cabeza = fila(obj.id, `${obj.id} (${obj.type})`);
      cabeza.classList.add('grupo');
      if (obj.id === estado.seleccion) cabeza.classList.add('principal');
      const flecha = boton(abierto ? '▾' : '▸', abierto ? `Collapse ${obj.id}` : `Expand ${obj.id} to see its channels`, () => {
        plegados.set(obj.id, !abierto);
        dibujar();
      }, 'plegar');
      cabeza.etiqueta.prepend(flecha);
      const nombre = cabeza.etiqueta.querySelector('.nombre-pista');
      nombre.style.cursor = 'pointer';
      nombre.addEventListener('click', () => seleccionarVarios(estado.seleccionados, obj.id));
      const props = canales.flatMap((c) => c.props);
      for (const t of tiemposDelCanal(clip, obj.id, props)) {
        const rombo = Object.assign(document.createElement('span'), { className: 'clave resumen', title: `${obj.id}: keyframes at ${n(t)} s. Click to go there; drag to move all of ${obj.id}'s keyframes at ${n(t)} s.` });
        rombo.style.left = izquierda(t);
        rombo.addEventListener('pointerdown', (e) => arrastrarMomento(e, clip, obj.id, t, cabeza.carril));
        cabeza.carril.append(rombo);
      }
      cuerpo.append(cabeza);
      if (abierto) for (const canal of canales) cuerpo.append(filaDeCanal(clip, obj, canal, izquierda));
    }

    cerrarPistas(cuerpo, duracion);
    return cuerpo;
  }

  /** Una fila de canal (Position, Rotation…) de un objeto: ◇/◆ para keyarla, × para borrarla y sus keyframes. */
  function filaDeCanal(clip, obj, canal, izquierda) {
    const conPista = canal.props.some((p) => clip.tracks?.[obj.id]?.[p]?.length);
    const f = fila(canal.nombre, `${obj.id}: ${canal.props.join(', ')}`);
    f.classList.add('canal');
    if (!conPista) f.classList.add('vacia');
    const clavar = boton(conPista ? '◆' : '◇', `Key ${obj.id} ${canal.nombre} at the playhead`, () => clavarCanal(clip, obj, canal), 'clavar-canal');
    const quitar = boton('×', `Delete the whole ${canal.nombre} track of ${obj.id} (all its keyframes)`, () => borrarCanal(clip, obj.id, canal), 'quitar-pista');
    if (!conPista) quitar.hidden = true;
    f.etiqueta.append(clavar, quitar);
    // Un param mueve todas las poses de sus drivers (también las que no se ven en la timeline): se dice al lado.
    if (obj.type === 'param') {
      const poses = estado.doc.objects.filter((o) => o.type === 'driver' && o.param === obj.id && buscar(estado.doc, o.pose)?.type === 'pose');
      const texto = poses.length ? `→ ${poses.map((d) => d.pose).join(', ')}` : '→ no driver';
      const detalle = poses.map((d) => `${d.pose} (driver ${d.id}): ${Object.keys(buscar(estado.doc, d.pose).values ?? {}).join(', ') || 'empty'}`).join('\n');
      f.etiqueta.append(Object.assign(document.createElement('span'), { className: 'poses-param', textContent: texto, title: poses.length ? `Animating ${obj.id} moves these poses (they all add up):\n${detalle}` : `${obj.id} has no driver: animating it moves nothing` }));
    }
    for (const t of tiemposDelCanal(clip, obj.id, canal.props)) {
      const claves = clavesEn(clip, obj.id, canal.props, t);
      const rombo = document.createElement('span');
      const esElegida = elegida && elegida.id === obj.id && elegida.canal === canal.nombre && mismoTiempo(elegida.t, t);
      rombo.className = `clave ${claseDeCurva(claves)}${esElegida ? ' elegida' : ''}`;
      rombo.style.left = izquierda(t);
      rombo.title = `${obj.id} ${canal.nombre} at ${n(t)} s: ${claves.map(([p, c]) => `${p} = ${resumir(c.value)}`).join(', ')} (${nombreDeCurva(claves)}). Drag to move it in time.`;
      rombo.addEventListener('pointerdown', (e) => arrastrarClave(e, clip, obj.id, canal, t, f.carril));
      f.carril.append(rombo);
    }
    return f;
  }

  /** El playhead y el clic o arrastre en la regla o en un carril vacío para moverlo. */
  function cerrarPistas(cuerpo, duracion) {
    const playhead = document.createElement('div');
    playhead.className = 'playhead';
    cuerpo.append(playhead);
    // Clic o arrastre en la regla o en un carril vacío: mover el playhead (con imán a los cuadros).
    cuerpo.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('.clave, .etiqueta, .ayuda-canales')) return;
      const zona = cuerpo.querySelector('.carril').getBoundingClientRect();
      const mover = (ev) => fijar({ tiempo: Math.max(0, Math.min(duracion, ajustarACuadro(((ev.clientX - zona.left) / zona.width) * duracion))) });
      detener();
      raiz.focus();
      mover(e);
      cuerpo.setPointerCapture(e.pointerId);
      cuerpo.onpointermove = mover;
      cuerpo.onpointerup = () => (cuerpo.onpointermove = cuerpo.onpointerup = null);
    });
    return cuerpo;
  }

  /** Una fila de la timeline: etiqueta a la izquierda y carril a la derecha. */
  function fila(texto, titulo) {
    const div = document.createElement('div');
    div.className = 'fila-pista';
    const etiqueta = document.createElement('span');
    etiqueta.className = 'etiqueta';
    etiqueta.append(Object.assign(document.createElement('span'), { className: 'nombre-pista', textContent: texto, title: titulo }));
    const carril = document.createElement('div');
    carril.className = 'carril';
    div.append(etiqueta, carril);
    return Object.assign(div, { etiqueta, carril });
  }

  /** ◇/◆ de un canal: keya sus propiedades en el playhead con lo que se ve (sin el aporte de los drivers). */
  function clavarCanal(clip, obj, canal) {
    const pose = poseActiva();
    const valores = Object.fromEntries(canal.props.map((k) => [k, obj.type === 'param' ? pose?.params?.[obj.id] : (pose?.values?.[obj.id]?.[k] ?? valorEfectivo(esquema, estado.doc, obj, k))]));
    clavarValores(clip, { [obj.id]: valores }, `${obj.id} ${canal.nombre}`);
  }

  /** Clic en un keyframe lo elige (y lleva el playhead ahí); arrastrarlo lo mueve en el tiempo, con todo su canal. */
  function arrastrarClave(e, clip, id, canal, t0, carril) {
    if (e.button !== 0) return;
    e.stopPropagation();
    detener();
    raiz.focus();
    // Se mide antes de elegir: elegir redibuja la timeline y este carril deja de estar en la página.
    const zona = carril.getBoundingClientRect();
    const props = clavesEn(clip, id, canal.props, t0).map(([p]) => p);
    elegida = { id, props, t: t0, canal: canal.nombre };
    // Cambia la barra (curva y borrar del keyframe elegido): se redibuja ya, no solo el playhead.
    dibujar();
    fijar({ tiempo: t0 });
    const duracion = leer(esquema, clip, 'duration');
    const x0 = e.clientX;
    let nuevo = t0;
    // moverClave falla si en el destino ya hay otro keyframe de la pista (soltarlo encima lo borraría).
    const ops = (t) => {
      let tracks = clip.tracks;
      for (const p of props) tracks = moverClave(tracks, id, p, t0, t);
      return [{ op: 'set', target: clip.id, props: { tracks } }];
    };
    // Elegir el keyframe redibuja la timeline (el rombo se reemplaza): el arrastre se sigue en window.
    const mover = (ev) => {
      if (Math.abs(ev.clientX - x0) < 3 && nuevo === t0) return;
      nuevo = Math.max(0, Math.min(duracion, ajustarACuadro(t0 + ((ev.clientX - x0) / zona.width) * duracion)));
      try {
        previsualizar(ops(nuevo));
      } catch {
        previsualizar(null);
      }
      fijar({ tiempo: nuevo });
    };
    window.addEventListener('pointermove', mover);
    window.addEventListener('pointerup', () => {
      window.removeEventListener('pointermove', mover);
      if (mismoTiempo(nuevo, t0)) return previsualizar(null);
      let lote;
      try {
        lote = ops(nuevo);
      } catch (error) {
        previsualizar(null);
        return avisar(error.message, true);
      }
      elegida = { id, props, t: redondearTiempo(nuevo), canal: canal.nombre };
      ejecutar(lote, `${clip.id}: move key ${id} ${canal.nombre} ${n(t0)} → ${n(nuevo)} s`);
    }, { once: true });
  }

  /**
   * Un ◆ de «All keys» (id null) o de la fila de un objeto: clic lleva el playhead ahí; arrastrar mueve el momento
   * entero (todos los keyframes de ese tiempo, del clip o del objeto), como move_keys de la IA.
   */
  function arrastrarMomento(e, clip, soloId, t0, carril) {
    if (e.button !== 0) return;
    e.stopPropagation();
    detener();
    raiz.focus();
    const zona = carril.getBoundingClientRect();
    const duracion = leer(esquema, clip, 'duration');
    const x0 = e.clientX;
    let nuevo = t0;
    fijar({ tiempo: t0 });
    const ops = (t) => {
      let tracks = clip.tracks;
      for (const [id, campos] of Object.entries(clip.tracks ?? {})) {
        if (soloId && id !== soloId) continue;
        for (const p of Object.keys(campos)) tracks = moverClave(tracks, id, p, t0, t) ?? tracks;
      }
      return [{ op: 'set', target: clip.id, props: { tracks } }];
    };
    const mover = (ev) => {
      if (Math.abs(ev.clientX - x0) < 3 && nuevo === t0) return;
      nuevo = Math.max(0, Math.min(duracion, ajustarACuadro(t0 + ((ev.clientX - x0) / zona.width) * duracion)));
      try {
        previsualizar(ops(nuevo));
      } catch {
        previsualizar(null);
      }
      fijar({ tiempo: nuevo });
    };
    window.addEventListener('pointermove', mover);
    window.addEventListener('pointerup', () => {
      window.removeEventListener('pointermove', mover);
      if (mismoTiempo(nuevo, t0)) return previsualizar(null);
      let lote;
      try {
        lote = ops(nuevo);
      } catch (error) {
        previsualizar(null);
        return avisar(error.message, true);
      }
      elegida = null;
      ejecutar(lote, `${clip.id}: move ${soloId ? `${soloId} keys` : 'keys'} ${n(t0)} → ${n(nuevo)} s`);
    }, { once: true });
  }

  function moverPlayhead() {
    const clip = clipVisible();
    if (!clip) return;
    const duracion = leer(esquema, clip, 'duration');
    const playhead = raiz.querySelector('.playhead');
    const carril = raiz.querySelector('.carril');
    if (playhead && carril) {
      const base = carril.offsetLeft;
      playhead.style.left = `${base + (Math.min(estado.tiempo, duracion) / duracion) * carril.offsetWidth}px`;
    }
    const reloj = raiz.querySelector('.reloj');
    if (reloj) reloj.textContent = `${estado.tiempo.toFixed(2)} s · frame ${Math.round(estado.tiempo * fps())}`;
  }
  new ResizeObserver(moverPlayhead).observe(raiz);
}

// Canales como en Moho: la posición (x, y) y la escala (scaleX, scaleY) van juntas en una fila; un param, su valor.
const JUNTAS = [['Position', ['x', 'y']], ['Rotation', ['rotation']], ['Scale', ['scaleX', 'scaleY']]];
const ETIQUETAS_DE_CANAL = { opacity: 'Opacity', visible: 'Visible', fill: 'Fill', stroke: 'Stroke', strokeWidth: 'Stroke width', vertices: 'Points', active: 'Switch', width: 'Width', height: 'Height', length: 'Length', cornerRadius: 'Corner radius' };

function canalesDe(obj) {
  if (obj.type === 'param') return [{ nombre: 'Value', props: ['value'] }];
  const tipo = esquema.tipos.get(obj.type);
  if (!tipo || tipo.resource) return [];
  const animables = Object.keys(tipo.properties).filter((k) => tipo.properties[k].animatable);
  const canales = [];
  const usadas = new Set();
  for (const [nombre, props] of JUNTAS) {
    const hay = props.filter((k) => animables.includes(k));
    if (!hay.length) continue;
    canales.push({ nombre, props: hay });
    hay.forEach((k) => usadas.add(k));
  }
  for (const k of animables) if (!usadas.has(k)) canales.push({ nombre: ETIQUETAS_DE_CANAL[k] ?? k, props: [k] });
  return canales;
}

/** Tiempos con keyframe en alguna de las propiedades de un canal. */
function tiemposDelCanal(clip, id, props) {
  const tiempos = [];
  for (const p of props) for (const c of clip.tracks?.[id]?.[p] ?? []) if (!tiempos.some((t) => mismoTiempo(t, c.t))) tiempos.push(c.t);
  return tiempos.sort((a, b) => a - b);
}

/** Los keyframes [propiedad, keyframe] de un canal en el tiempo t. */
function clavesEn(clip, id, props, t) {
  return (props ?? []).flatMap((p) => {
    const c = clip?.tracks?.[id]?.[p]?.find((k) => mismoTiempo(k.t, t));
    return c ? [[p, c]] : [];
  });
}

/** El color del ◆ dice la curva del tramo que sale de él (como la forma del keyframe en Moho). */
function claseDeCurva(claves) {
  const curvas = new Set(claves.map(([, c]) => (Array.isArray(c.ease) ? 'bezier' : (c.ease ?? 'linear'))));
  if (curvas.size > 1) return 'curva-mixta';
  const [curva] = curvas;
  return `curva-${curva.startsWith('ease-') ? 'ease' : curva}`;
}

/** Un dibujito de la curva de un tramo (tiempo → avance), para ver la forma sin adivinar los números. */
function formaDeCurva(ease) {
  const [ancho, alto, margen] = [36, 20, 4];
  const y = (v) => margen + (1 - v) * (alto - 2 * margen);
  const puntos = Array.from({ length: 25 }, (_, i) => {
    const f = i / 24;
    return `${(f * ancho).toFixed(1)},${y(ease === 'step' ? (f < 1 ? 0 : 1) : aplicarCurva(ease, f)).toFixed(1)}`;
  });
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${ancho} ${alto}`);
  svg.setAttribute('class', 'forma-curva');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = `<line x1="0" y1="${y(0)}" x2="${ancho}" y2="${y(0)}"/><line x1="0" y1="${y(1)}" x2="${ancho}" y2="${y(1)}"/><polyline points="${puntos.join(' ')}"/>`;
  return svg;
}
function nombreDeCurva(claves) {
  const nombres = [...new Set(claves.map(([, c]) => (Array.isArray(c.ease) ? `cubic-bezier(${c.ease.join(', ')})` : (c.ease ?? 'linear'))))];
  return nombres.join(' / ');
}

function resumir(v) {
  if (Array.isArray(v)) return `(${v.length} points)`;
  return typeof v === 'number' ? n(v) : JSON.stringify(v);
}
