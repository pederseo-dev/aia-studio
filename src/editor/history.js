// Historial: quién cambió qué (IA o usuario). Lo deshecho aparece tachado.

import { state, subscribe } from './state.js';

export function mountHistory(list) {
  subscribe((c) => {
    if ('history' in c) draw();
  });

  function draw() {
    const { entries } = state.history;

    const byNumber = new Map(entries.map((e) => [e.n, e]));
    const reverted = new Set();
    for (const e of entries) {
      if (e.tipo === 'deshacer') reverted.add(e.ref);
      if (e.tipo === 'rehacer') reverted.delete(byNumber.get(e.ref)?.ref);
    }

    list.replaceChildren(
      ...entries
        .filter((e) => e.tipo === 'cambio' || e.tipo === 'crear' || e.tipo === 'migracion')
        .reverse()
        .slice(0, 40)
        .map((e) => {
          const li = document.createElement('li');
          li.className = `${e.origen}${reverted.has(e.n) ? ' revertida' : ''}`;
          li.innerHTML = `<span class="quien">${e.origen === 'ai' ? 'AI' : e.origen === 'system' ? 'System' : 'You'}</span><span class="hora"></span><span class="nota"></span>`;
          li.querySelector('.hora').textContent = new Date(e.fecha).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          li.querySelector('.nota').textContent = e.nota;
          li.title = `${e.nota}\n${e.ops.length} operations`;
          return li;
        }),
    );
  }
}
