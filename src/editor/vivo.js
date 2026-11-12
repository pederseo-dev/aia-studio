// ▶ Live (Puppet): el muñeco en marcha dentro del editor, con el mismo runtime que la app (src/core/vivo.js). Con
// Live encendido el documento no se edita: los botones de los clips los disparan, los controles de Parameters son
// los valores de la app (no se guardan) y el lienzo muestra lo que vería la app. Ver docs/decision-animacion.md §9.

import { crearVivo } from '../core/vivo.js';
import { buscar } from '../core/documento.js';
import { leer } from '../core/esquema.js';
import { manifiesto, textoDeManifiesto } from '../core/manifiesto.js';
import { avisar, esquema, estado, fijar, suscribir } from './estado.js';

let vivo = null;
let cuadro = null;
let antes = 0;
// Los valores de Parameters de antes de Live: al apagarlo vuelven (los de Live son de la app y no se quedan).
let paramsDeAntes = null;

/** El runtime en marcha (o null si Live está apagado). */
export const runtimeVivo = () => vivo;

function paso(ahora) {
  if (!vivo) return;
  // Un cuadro largo (la pestaña estuvo oculta) no salta el fundido entero.
  const dt = Math.min(0.1, (ahora - antes) / 1000);
  antes = ahora;
  vivo.avanzar(dt);
  fijar({ poseViva: vivo.pose(), estadoVivo: vivo.estado() });
  cuadro = requestAnimationFrame(paso);
}

export function encenderLive() {
  if (vivo || !estado.doc || estado.modo !== 'puppet') return;
  // Solo los valores que siguen valiendo (un param pudo borrarse o perder esa opción mientras tanto).
  const validos = Object.fromEntries(
    Object.entries(estado.params ?? {}).filter(([id, v]) => {
      const p = buscar(estado.doc, id);
      return p?.type === 'param' && (leer(esquema, p, 'kind') !== 'enum' || leer(esquema, p, 'options').includes(v));
    }),
  );
  try {
    vivo = crearVivo(estado.doc, esquema, { params: validos, semilla: Math.floor(Math.random() * 2 ** 31) });
  } catch (e) {
    vivo = null;
    return avisar(e.message, true);
  }
  paramsDeAntes = estado.params;
  antes = performance.now();
  fijar({ vivo: true, reproduciendo: false, previa: null, poseViva: vivo.pose(), estadoVivo: vivo.estado() });
  cuadro = requestAnimationFrame(paso);
}

/** Apaga Live. `restaurar`: los valores de Parameters vuelven a los de antes (no si se cambió de modo o de documento). */
export function apagarLive({ restaurar = true } = {}) {
  if (!vivo) return;
  cancelAnimationFrame(cuadro);
  vivo = null;
  fijar({ vivo: false, poseViva: null, estadoVivo: null, ...(restaurar ? { params: paramsDeAntes } : {}) });
  paramsDeAntes = null;
}

/** ■ Stop all: todo lo que disparó la app sale con su fundido (los auto siguen). */
export const pararTodo = () => vivo?.stop();

/**
 * Lo que verá la IA de la app (el mismo texto que get_manifest), en un diálogo. Así la persona ve lo mismo que la IA
 * que edita: params con lo que mueven, clips con lo que pisan y los problemas.
 */
export function mostrarManifiesto() {
  if (!estado.doc) return;
  const dialogo = document.createElement('dialog');
  dialogo.className = 'manifiesto';
  dialogo.innerHTML = '<h2>What the app’s AI sees</h2><pre></pre><form method="dialog"><button type="submit">Close</button></form>';
  dialogo.querySelector('pre').textContent = textoDeManifiesto(manifiesto(estado.doc, esquema));
  dialogo.addEventListener('close', () => dialogo.remove());
  document.body.append(dialogo);
  dialogo.showModal();
}

export const alternarLive = () => (vivo ? apagarLive() : encenderLive());

/** Dispara un clip (play) o lo saca (stop) en vivo; los errores van al aviso. */
export function dispararClip(id, { parar = false } = {}) {
  if (!vivo) return;
  try {
    if (parar) vivo.stop(id);
    else vivo.play(id);
  } catch (e) {
    avisar(e.message, true);
  }
}

/** Un valor de la app (los controles de Parameters con Live encendido). */
export function ponerParamVivo(id, valor) {
  if (!vivo) return;
  try {
    vivo.set(id, valor);
    fijar({ params: { ...(estado.params ?? {}), [id]: valor } });
  } catch (e) {
    avisar(e.message, true);
  }
}

// Live es de Puppet y de un documento: cambiar de modo o de documento lo apaga. Con Live no se edita a mano, pero el
// documento puede cambiar igual (la IA por MCP, o deshacer): el runtime sigue con el nuevo.
suscribir((c) => {
  if (!vivo) return;
  if (('modo' in c && estado.modo !== 'puppet') || 'id' in c) return apagarLive({ restaurar: false });
  if ('doc' in c && estado.doc) vivo.actualizar(estado.doc);
});
