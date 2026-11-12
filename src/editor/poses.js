// Puppet: la lista de poses (a la derecha, debajo de Parameters) y el cartel arriba del lienzo que dice qué se está
// editando. Las poses son fotos fijas del muñeco que los params mezclan; antes se elegían en un desplegable «View»
// arriba, que parecía un modo de vista. Ver docs/decision-animacion.md §10.

import { buscar } from '../core/documento.js';
import { avisar, ejecutar, estado, fijar, suscribir } from './estado.js';
import { alternarLive } from './vivo.js';

/** Los params que mueven una pose (por sus drivers). */
const paramsDePose = (doc, pose) => [...new Set(doc.objects.filter((d) => d.type === 'driver' && d.pose === pose && d.param).map((d) => d.param))];

/** Abre una pose para editarla (o la cierra si ya está abierta): lo que se cambia va a la pose, no al montaje. */
export function abrirPose(id) {
  if (estado.vivo) return avisar('Live is on: turn it off (■ Live) to edit a pose.', true);
  if (estado.pose === id) return fijar({ pose: null, params: estado.params ?? {}, edicion: null, vertice: null });
  fijar({ pose: id, edicion: null, vertice: null, reproduciendo: false });
}

export function montarPoses(raiz, lista, botonNueva) {
  botonNueva.addEventListener('click', () => {
    if (!estado.doc) return;
    const base = prompt('Pose name (e.g. happy, eyes_closed, mouth_o):', '')?.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
    if (!base) return;
    const id = /^[a-z]/.test(base) ? base : `pose_${base}`;
    if (buscar(estado.doc, id)) return avisar(`"${id}" already exists`, true);
    ejecutar([{ op: 'create', type: 'pose', id }], `create pose ${id}`);
    abrirPose(id);
  });
  suscribir((c) => {
    if ('doc' in c || 'pose' in c || 'modo' in c || 'id' in c || 'vivo' in c) dibujar();
  });

  function dibujar() {
    const doc = estado.doc;
    raiz.hidden = estado.modo !== 'puppet' || !doc;
    botonNueva.disabled = estado.vivo;
    if (raiz.hidden) return;
    const poses = doc.objects.filter((o) => o.type === 'pose');
    if (!poses.length) {
      lista.innerHTML = '<p class="ayuda">No poses yet. A pose is a still shape of the puppet (happy, eyes closed, mouth O…). Create one with “＋ Pose”, change it on the canvas, then blend it with a parameter.</p>';
      return;
    }
    lista.replaceChildren(
      ...poses.map((pose) => {
        const abierta = estado.pose === pose.id;
        const fila = Object.assign(document.createElement('button'), { type: 'button', className: `pose-fila${abierta ? ' abierta' : ''}`, disabled: estado.vivo });
        const params = paramsDePose(doc, pose.id);
        fila.innerHTML = '<b></b><small></small>';
        fila.querySelector('b').textContent = pose.id;
        fila.querySelector('small').textContent = params.length ? `← ${params.join(', ')}` : 'no parameter';
        const objetos = Object.keys(pose.values ?? {});
        fila.title = `${abierta ? 'Click to stop editing this pose' : 'Click to edit this pose'}. It sets: ${objetos.join(', ') || 'nothing yet'}.${params.length ? ` Blended by: ${params.join(', ')}.` : ' No parameter blends it yet: connect one with “＋ Pose…” under a parameter.'}`;
        fila.addEventListener('click', () => abrirPose(pose.id));
        return fila;
      }),
    );
  }
}

/**
 * Cartel arriba del lienzo (solo Puppet): qué se está editando o viendo, en el color del marco, con el botón para
 * salir. Reemplaza al desplegable «View».
 */
export function montarCartel(el) {
  suscribir((c) => {
    if ('doc' in c || 'pose' in c || 'params' in c || 'modo' in c || 'id' in c || 'vivo' in c || ('tiempo' in c && !estado.reproduciendo) || 'reproduciendo' in c) dibujar();
  });

  function dibujar() {
    const doc = estado.doc;
    el.hidden = estado.modo !== 'puppet' || !doc;
    if (el.hidden) return;
    const abierto = estado.pose && buscar(doc, estado.pose);
    let clase;
    let texto;
    let boton;
    if (estado.vivo) {
      [clase, texto] = ['vivo', '<b>● Live</b>: the puppet as the app sees it. Nothing is saved.'];
      boton = ['■ Stop Live', 'Turn Live off and go back to editing', alternarLive];
    } else if (abierto?.type === 'animation') {
      [clase, texto] = ['clip', `Editing clip <b></b> at ${+estado.tiempo.toFixed(2)} s: every change is a keyframe at the playhead.`];
      boton = ['Close clip', 'Back to the parameter preview', () => fijar({ pose: null, params: estado.params ?? {}, edicion: null, vertice: null, reproduciendo: false })];
    } else if (abierto?.type === 'pose') {
      [clase, texto] = ['pose', 'Editing pose <b></b>: what you change goes into the pose, not the setup.'];
      boton = ['Done', 'Stop editing the pose and go back to the parameter preview', () => abrirPose(abierto.id)];
    } else {
      [clase, texto] = ['params', 'Previewing <b>parameters</b>: the canvas shows the poses they blend. To change a pose, open it under Poses.'];
      boton = ['Reset', 'Put every parameter back to its initial value', () => fijar({ params: {} })];
    }
    el.className = `cartel-${clase}`;
    el.innerHTML = `<span>${texto}</span>`;
    if (clase === 'clip' || clase === 'pose') el.querySelector('span b').textContent = abierto.id;
    const b = Object.assign(document.createElement('button'), { type: 'button', textContent: boton[0], title: boton[1] });
    b.addEventListener('click', boton[2]);
    el.append(b);
  }
}
