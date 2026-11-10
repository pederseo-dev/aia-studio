// Historial: quién cambió qué (IA o usuario). Lo deshecho aparece tachado.

import { estado, suscribir } from './estado.js';

export function montarHistorial(lista) {
  suscribir((c) => {
    if ('historial' in c) dibujar();
  });

  function dibujar() {
    const { entradas } = estado.historial;

    const porNumero = new Map(entradas.map((e) => [e.n, e]));
    const revertidas = new Set();
    for (const e of entradas) {
      if (e.tipo === 'deshacer') revertidas.add(e.ref);
      if (e.tipo === 'rehacer') revertidas.delete(porNumero.get(e.ref)?.ref);
    }

    lista.replaceChildren(
      ...entradas
        .filter((e) => e.tipo === 'cambio' || e.tipo === 'crear' || e.tipo === 'migracion')
        .reverse()
        .slice(0, 40)
        .map((e) => {
          const li = document.createElement('li');
          li.className = `${e.origen}${revertidas.has(e.n) ? ' revertida' : ''}`;
          li.innerHTML = `<span class="quien">${e.origen === 'ai' ? 'AI' : e.origen === 'system' ? 'System' : 'You'}</span><span class="hora"></span><span class="nota"></span>`;
          li.querySelector('.hora').textContent = new Date(e.fecha).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          li.querySelector('.nota').textContent = e.nota;
          li.title = `${e.nota}\n${e.ops.length} operations`;
          return li;
        }),
    );
  }
}
