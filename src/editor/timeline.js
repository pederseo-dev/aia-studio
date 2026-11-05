// Modos del editor (Design · Animate · Puppet), la timeline de abajo y la biblioteca de clips de Puppet. Ver
// docs/decision-animacion.md.
//
// Un clip abierto se edita como una pose (estado.pose = id del clip): lo que se cambia en el lienzo o en el inspector
// queda como keyframe en el tiempo del playhead (autokey, ver opsDePose en huesos.js).

import { avisosDeClip, moverClave, ponerClave, quitarClave, redondearTiempo, tiempoLocal, valorAGuardar, valoresDeMontaje } from '../core/animacion.js';
import { NOMBRES_DE_CURVA, errorDeCurva, mismoTiempo } from '../core/curvas.js';
import { buscar } from '../core/documento.js';
import { leer, leerMeta } from '../core/esquema.js';
import { valorEfectivo } from '../core/estilos.js';
import { avisar, ejecutar, esquema, estado, fijar, previsualizar, seleccionar, suscribir } from './estado.js';
import { clipAbierto, poseActiva } from './huesos.js';

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
  fijar({ pose: id, tiempo: 0, edicion: null, vertice: null, abajo: 'timeline' });
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
    return fijar({ modo, pose: escena?.id ?? null, params: null, tiempo: 0, edicion: null, vertice: null, abajo: 'timeline' });
  }
  // Puppet: se ve la mezcla de los params; los clips se abren desde la biblioteca de la derecha.
  fijar({ modo, pose: null, params: estado.params ?? {}, tiempo: 0, edicion: null, vertice: null, abajo: 'parametros' });
}

// ---------- Biblioteca de clips (Puppet) ----------

export function montarClips(raiz, lista, botonNuevo) {
  botonNuevo.addEventListener('click', () => nuevoClip('puppet'));
  suscribir((c) => {
    if ('doc' in c || 'pose' in c || 'modo' in c || 'id' in c || 'reproduciendo' in c) dibujar();
  });

  function dibujar() {
    const doc = estado.doc;
    raiz.hidden = estado.modo !== 'puppet' || !doc;
    if (raiz.hidden) return;
    const clips = doc.objects.filter((o) => o.type === 'animation' && leer(esquema, o, 'usage') === 'puppet');
    if (!clips.length) {
      lista.innerHTML = '<p class="ayuda">No clips yet. A clip is a short animation the app or its AI triggers (wave, blink, idle). Create one with “＋ Clip”.</p>';
      return;
    }
    lista.replaceChildren(
      ...clips.map((clip) => {
        const abierto = estado.pose === clip.id;
        const fila = document.createElement('div');
        fila.className = `clip${abierto ? ' abierto' : ''}`;
        const boton = Object.assign(document.createElement('button'), { type: 'button', className: 'nombre' });
        const descripcion = leer(esquema, clip, 'description');
        boton.innerHTML = `<b></b><small></small>`;
        boton.querySelector('b').textContent = clip.id;
        boton.querySelector('small').textContent = `${n(leer(esquema, clip, 'duration'))} s · ${leer(esquema, clip, 'loop')}`;
        boton.title = `${descripcion ? `${descripcion}\n` : ''}Click to edit it in the timeline`;
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
      }),
    );
  }
}

// ---------- Timeline ----------

export function montarTimeline(raiz) {
  // Keyframe elegido: { id, prop, t } (solo del editor).
  let elegida = null;
  raiz.tabIndex = -1;

  suscribir((c) => {
    if ('doc' in c || 'previa' in c || 'pose' in c || 'modo' in c || 'id' in c || 'seleccion' in c || 'reproduciendo' in c) dibujar();
    else if ('tiempo' in c) moverPlayhead();
  });

  const clipVisible = () => clipAbierto(estado.previa ?? estado.doc);
  const fps = () => leerMeta(esquema, estado.doc, 'fps');
  const ajustarACuadro = (t) => redondearTiempo(Math.round(t * fps()) / fps());

  function dibujar() {
    const doc = estado.doc;
    if (!doc) return raiz.replaceChildren();
    const clip = clipVisible();
    if (elegida && !clip?.tracks?.[elegida.id]?.[elegida.prop]?.some((c) => mismoTiempo(c.t, elegida.t))) elegida = null;
    raiz.replaceChildren(barra(doc, clip), clip ? pistas(clip) : vacio());
    moverPlayhead();
  }

  function vacio() {
    const p = document.createElement('p');
    p.className = 'ayuda';
    p.innerHTML =
      estado.modo === 'animate'
        ? 'No scene yet. Create one with “＋ Scene”: then move the playhead and change things on the canvas or in the inspector — each change is keyed at the playhead.'
        : 'Pick a clip on the right (or create one with “＋ Clip”) to edit its keyframes here.';
    return p;
  }

  function barra(doc, clip) {
    const div = document.createElement('div');
    div.className = 'barra-tiempo';
    if (estado.modo === 'animate') {
      const escenas = doc.objects.filter((o) => o.type === 'animation' && leer(esquema, o, 'usage') === 'animate');
      const select = document.createElement('select');
      select.title = 'Scene being edited';
      select.append(...(escenas.length ? escenas.map((e) => new Option(e.id, e.id, false, e.id === clip?.id)) : [new Option('(no scenes)', '')]));
      select.disabled = !escenas.length;
      select.addEventListener('change', () => abrirClip(select.value));
      div.append(select, boton('＋ Scene', 'New scene timeline', () => nuevoClip('animate')));
    } else if (clip) {
      div.append(Object.assign(document.createElement('strong'), { className: 'nombre-clip', textContent: clip.id, title: leer(esquema, clip, 'description') || 'Puppet clip' }));
    }
    if (!clip) return div;

    const duracion = leer(esquema, clip, 'duration');
    div.append(
      boton('⏮', 'Go to the start', () => fijar({ tiempo: 0 })),
      boton(estado.reproduciendo ? '⏸' : '▶', estado.reproduciendo ? 'Pause' : 'Play', () => (estado.reproduciendo ? detener() : reproducir()), 'play'),
      Object.assign(document.createElement('span'), { className: 'reloj' }),
    );

    const campoDuracion = Object.assign(document.createElement('input'), { type: 'number', min: 0.05, step: 0.1, value: n(duracion), title: 'Duration in seconds' });
    campoDuracion.addEventListener('change', () => {
      const v = Number(campoDuracion.value);
      if (!(v > 0)) return dibujar();
      const ultima = Math.max(0, ...Object.values(clip.tracks ?? {}).flatMap((c) => Object.values(c).flatMap((k) => k.map((x) => x.t))));
      if (v < ultima) {
        avisar(`There are keyframes up to ${n(ultima)} s: move or delete them before shortening the clip`, true);
        return dibujar();
      }
      ejecutar([{ op: 'set', target: clip.id, props: { duration: v } }], `${clip.id} duration ${v} s`);
      if (estado.tiempo > v) fijar({ tiempo: v });
    });
    const etiquetaDuracion = Object.assign(document.createElement('label'), { className: 'campo-corto', textContent: 'Length' });
    etiquetaDuracion.append(campoDuracion, document.createTextNode('s'));

    const loop = document.createElement('select');
    loop.title = 'once: plays once and holds the end · loop: starts over · pingpong: back and forth';
    for (const v of ['once', 'loop', 'pingpong']) loop.append(new Option(v, v, false, v === leer(esquema, clip, 'loop')));
    loop.addEventListener('change', () => ejecutar([{ op: 'set', target: clip.id, props: { loop: loop.value } }], `${clip.id} loop ${loop.value}`));

    div.append(etiquetaDuracion, loop, boton('◆ Key', 'Key the selected object at the playhead: its animated properties (or, if it has none, its rotation and position)', () => clavarSeleccion(clip)));

    // Una pose entera como keyframes en el playhead, y volver al montaje (lo mismo que pose y setup en set_keys).
    const poses = doc.objects.filter((o) => o.type === 'pose');
    if (poses.length) {
      const conPose = document.createElement('select');
      conPose.title = 'Key all the values of a pose at the playhead';
      conPose.append(new Option('◆ Pose…', ''), ...poses.map((p) => new Option(p.id, p.id)));
      conPose.addEventListener('change', () => conPose.value && clavarValores(clip, structuredClone(buscar(estado.doc, conPose.value).values ?? {}), `pose ${conPose.value}`, false));
      div.append(conPose);
    }
    div.append(boton('◆ Setup', 'Key the setup values (the rest pose) of everything this clip animates at the playhead, and its parameters at their initial value', () => {
      const valores = valoresDeMontaje(estado.doc, esquema, clip.tracks);
      if (!Object.keys(valores).length) return avisar('This clip animates nothing yet: key something first', true);
      clavarValores(clip, valores, 'setup', false);
    }));

    // Drivers que suman encima de pistas del clip (lo mismo que avisan set_keys y render_preview a la IA).
    const avisos = avisosDeClip(doc, esquema, clip, estado.params ?? {});
    if (avisos.length) div.append(Object.assign(document.createElement('span'), { className: 'aviso-drivers', textContent: `⚠ ${avisos.length} driver${avisos.length > 1 ? 's' : ''} add on top`, title: avisos.join('\n') }));

    // Curva y borrar del keyframe elegido.
    if (elegida) {
      const clave = clip.tracks[elegida.id][elegida.prop].find((c) => mismoTiempo(c.t, elegida.t));
      const curva = document.createElement('select');
      curva.title = 'Ease of the segment that leaves this keyframe';
      const actual = Array.isArray(clave.ease) ? 'custom' : (clave.ease ?? 'linear');
      for (const v of NOMBRES_DE_CURVA) curva.append(new Option(v, v, false, v === actual));
      if (actual === 'custom') curva.append(new Option(`cubic-bezier(${clave.ease.join(', ')})`, 'custom', false, true));
      curva.append(new Option('cubic-bezier…', 'editar'));
      curva.addEventListener('change', () => {
        let ease = curva.value;
        if (ease === 'custom') return;
        if (ease === 'editar') {
          // Como en CSS: x1, y1, x2, y2 (x entre 0 y 1; y puede pasarse para un rebote).
          const previa = Array.isArray(clave.ease) ? clave.ease.join(', ') : '0.3, 1.6, 0.6, 1';
          const texto = prompt('cubic-bezier x1, y1, x2, y2 (as in CSS; y outside 0…1 overshoots):', previa);
          if (texto == null) return dibujar();
          ease = texto.split(/[\s,]+/).filter(Boolean).map(Number);
          const error = errorDeCurva(ease);
          if (error) {
            avisar(error, true);
            return dibujar();
          }
        }
        const tracks = ponerClave(clip.tracks, elegida.id, elegida.prop, clave.t, clave.value, ease);
        ejecutar([{ op: 'set', target: clip.id, props: { tracks } }], `${clip.id}: ease ${Array.isArray(ease) ? `cubic-bezier(${ease.join(', ')})` : ease} at ${n(clave.t)} s`);
      });
      const etiqueta = Object.assign(document.createElement('label'), { className: 'campo-corto', textContent: `${elegida.id}.${elegida.prop} @ ${n(clave.t)} s` });
      etiqueta.append(curva);
      div.append(etiqueta, boton('Delete key', 'Delete this keyframe (Del)', () => borrarElegida(clip)));
    }
    if (estado.modo === 'puppet') {
      const descripcion = Object.assign(document.createElement('input'), { type: 'text', className: 'descripcion', value: leer(esquema, clip, 'description'), placeholder: 'What it does (for the app’s AI)' });
      descripcion.addEventListener('change', () => ejecutar([{ op: 'set', target: clip.id, props: { description: descripcion.value } }], `${clip.id} description`));
      div.append(descripcion);
    }
    return div;
  }

  function boton(texto, titulo, accion, clase = '') {
    const b = Object.assign(document.createElement('button'), { type: 'button', textContent: texto, title: titulo, className: clase });
    b.addEventListener('click', accion);
    return b;
  }

  /** ◆ Key: el objeto seleccionado en el tiempo del playhead, con lo que tiene pista o, si no, rotación y posición. */
  function clavarSeleccion(clip) {
    const obj = estado.seleccion && buscar(estado.doc, estado.seleccion);
    if (!obj || esquema.tipos.get(obj.type).resource) return avisar('Select an object (or a bone) to key it', true);
    const props = esquema.tipos.get(obj.type).properties;
    let claves = Object.keys(clip.tracks?.[obj.id] ?? {});
    if (!claves.length) claves = (obj.type === 'bone' ? ['rotation'] : ['x', 'y', 'rotation']).filter((k) => props[k]?.animatable);
    if (!claves.length) return avisar(`${obj.id} has nothing to key here: change a value in the inspector to key it`, true);
    const pose = poseActiva();
    clavarValores(clip, { [obj.id]: Object.fromEntries(claves.map((k) => [k, pose?.values?.[obj.id]?.[k] ?? valorEfectivo(esquema, estado.doc, obj, k)])) }, obj.id);
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

  /** Borra una pista entera (todos sus keyframes). */
  function borrarPista(clip, id, prop) {
    const tracks = structuredClone(clip.tracks ?? {});
    delete tracks[id]?.[prop];
    if (tracks[id] && !Object.keys(tracks[id]).length) delete tracks[id];
    ejecutar([{ op: 'set', target: clip.id, props: { tracks } }], `${clip.id}: delete track ${id}.${prop}`);
  }

  function borrarElegida(clip) {
    if (!elegida) return;
    const tracks = quitarClave(clip.tracks, elegida.id, elegida.prop, elegida.t);
    ejecutar([{ op: 'set', target: clip.id, props: { tracks } }], `${clip.id}: delete key ${elegida.id}.${elegida.prop} at ${n(elegida.t)} s`);
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

  /** La regla, una fila por pista y el playhead. */
  function pistas(clip) {
    const duracion = leer(esquema, clip, 'duration');
    const cuerpo = document.createElement('div');
    cuerpo.className = 'pistas';
    const filas = Object.entries(clip.tracks ?? {}).flatMap(([id, campos]) => Object.keys(campos).map((prop) => [id, prop]));

    const regla = document.createElement('div');
    regla.className = 'fila-pista regla';
    const carril = document.createElement('div');
    carril.className = 'carril';
    // Marcas: cada segundo con número, y cada cuadro (si caben) como rayita.
    const pasoMarca = duracion > 20 ? 5 : duracion > 8 ? 2 : duracion > 3 ? 1 : duracion > 1 ? 0.5 : 0.25;
    for (let t = 0; t <= duracion + 1e-9; t += pasoMarca) {
      const marca = Object.assign(document.createElement('span'), { className: 'marca', textContent: `${n(t)}s` });
      marca.style.left = `${(t / duracion) * 100}%`;
      carril.append(marca);
    }
    regla.append(Object.assign(document.createElement('span'), { className: 'etiqueta', textContent: filas.length ? '' : 'No keyframes yet' }), carril);
    cuerpo.append(regla);

    for (const [id, prop] of filas) {
      const fila = document.createElement('div');
      fila.className = `fila-pista${id === estado.seleccion ? ' seleccionada' : ''}`;
      const etiqueta = document.createElement('span');
      etiqueta.className = 'etiqueta';
      const nombre = Object.assign(document.createElement('button'), { type: 'button', className: 'nombre-pista', textContent: `${id}.${prop}`, title: `Select ${id}` });
      nombre.addEventListener('click', () => seleccionar(id));
      const quitar = Object.assign(document.createElement('button'), { type: 'button', className: 'quitar-pista', textContent: '×', title: `Delete the whole ${id}.${prop} track (all its keyframes)` });
      quitar.addEventListener('click', () => borrarPista(clip, id, prop));
      etiqueta.append(nombre, quitar);
      const carrilPista = document.createElement('div');
      carrilPista.className = 'carril';
      for (const clave of clip.tracks[id][prop]) {
        const rombo = document.createElement('span');
        const esElegida = elegida && elegida.id === id && elegida.prop === prop && mismoTiempo(elegida.t, clave.t);
        rombo.className = `clave${esElegida ? ' elegida' : ''}${clave.ease === 'step' ? ' step' : ''}`;
        rombo.style.left = `${(clave.t / duracion) * 100}%`;
        rombo.title = `${id}.${prop} = ${resumir(clave.value)} at ${n(clave.t)} s (${Array.isArray(clave.ease) ? 'cubic-bezier' : (clave.ease ?? 'linear')}). Drag to move it in time.`;
        rombo.addEventListener('pointerdown', (e) => arrastrarClave(e, clip, id, prop, clave, carrilPista));
        carrilPista.append(rombo);
      }
      fila.append(etiqueta, carrilPista);
      cuerpo.append(fila);
    }
    const playhead = document.createElement('div');
    playhead.className = 'playhead';
    cuerpo.append(playhead);
    // Clic o arrastre en la regla o en un carril vacío: mover el playhead (con imán a los cuadros).
    cuerpo.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('.clave, .etiqueta')) return;
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

  /** Clic en un keyframe lo elige (y lleva el playhead ahí); arrastrarlo lo mueve en el tiempo. */
  function arrastrarClave(e, clip, id, prop, clave, carril) {
    if (e.button !== 0) return;
    e.stopPropagation();
    detener();
    raiz.focus();
    // Se mide antes de elegir: elegir redibuja la timeline y este carril deja de estar en la página.
    const zona = carril.getBoundingClientRect();
    elegida = { id, prop, t: clave.t };
    seleccionar(id);
    fijar({ tiempo: clave.t });
    const duracion = leer(esquema, clip, 'duration');
    const x0 = e.clientX;
    let nuevo = clave.t;
    // moverClave falla si en el destino ya hay otro keyframe de la pista (soltarlo encima lo borraría).
    const ops = (t) => [{ op: 'set', target: clip.id, props: { tracks: moverClave(clip.tracks, id, prop, clave.t, t) } }];
    // Elegir el keyframe redibuja la timeline (el rombo se reemplaza): el arrastre se sigue en window.
    const mover = (ev) => {
      if (Math.abs(ev.clientX - x0) < 3 && nuevo === clave.t) return;
      nuevo = Math.max(0, Math.min(duracion, ajustarACuadro(clave.t + ((ev.clientX - x0) / zona.width) * duracion)));
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
      if (mismoTiempo(nuevo, clave.t)) return previsualizar(null);
      let lote;
      try {
        lote = ops(nuevo);
      } catch (error) {
        previsualizar(null);
        return avisar(error.message, true);
      }
      elegida = { id, prop, t: redondearTiempo(nuevo) };
      ejecutar(lote, `${clip.id}: move key ${id}.${prop} ${n(clave.t)} → ${n(nuevo)} s`);
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

function resumir(v) {
  if (Array.isArray(v)) return `(${v.length} points)`;
  return typeof v === 'number' ? n(v) : JSON.stringify(v);
}
