// ▶ Live (Puppet): el muñeco en marcha dentro del editor, con el mismo runtime que la app (src/core/vivo.js). Con
// Live encendido el documento no se edita: los botones de los clips los disparan, los controles de Parameters son
// los valores de la app (no se guardan) y el lienzo muestra lo que vería la app. Ver docs/decision-animacion.md §9.

import { crearVivo } from '../core/vivo.js';
import { avisar, esquema, estado, fijar, suscribir } from './estado.js';

let vivo = null;
let cuadro = null;
let antes = 0;

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
  vivo = crearVivo(estado.doc, esquema, { params: estado.params ?? {}, semilla: Math.floor(Math.random() * 2 ** 31) });
  antes = performance.now();
  fijar({ vivo: true, reproduciendo: false, previa: null, poseViva: vivo.pose(), estadoVivo: vivo.estado() });
  cuadro = requestAnimationFrame(paso);
}

export function apagarLive() {
  if (!vivo) return;
  cancelAnimationFrame(cuadro);
  vivo = null;
  fijar({ vivo: false, poseViva: null, estadoVivo: null });
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

// Live es de Puppet y de un documento: cambiar de modo o de documento lo apaga. Si el documento cambia (la IA edita
// mientras tanto), el runtime sigue con el nuevo.
suscribir((c) => {
  if (!vivo) return;
  if (('modo' in c && estado.modo !== 'puppet') || 'id' in c) return apagarLive();
  if ('doc' in c && estado.doc) vivo.actualizar(estado.doc);
});
