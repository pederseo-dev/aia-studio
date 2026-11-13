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
      if (e.kind === 'undo') reverted.add(e.ref);
      if (e.kind === 'redo') reverted.delete(byNumber.get(e.ref)?.ref);
    }

    list.replaceChildren(
      ...entries
        .filter((e) => e.kind === 'change' || e.kind === 'create' || e.kind === 'migration')
        .reverse()
        .slice(0, 40)
        .map((e) => {
          const li = document.createElement('li');
          li.className = `${e.origin}${reverted.has(e.n) ? ' reverted' : ''}`;
          li.innerHTML = `<span class="who">${e.origin === 'ai' ? 'AI' : e.origin === 'system' ? 'System' : 'You'}</span><span class="clock-time"></span><span class="note"></span>`;
          li.querySelector('.clock-time').textContent = new Date(e.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          li.querySelector('.note').textContent = e.note;
          li.title = `${e.note}\n${e.ops.length} operations`;
          return li;
        }),
    );
  }
}
