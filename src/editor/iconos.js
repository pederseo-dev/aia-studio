// Íconos de línea para la barra de herramientas (trazo de 1.5 en una caja de 24, color del texto).

const trazo = (cuerpo) =>
  `<svg class="ico" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${cuerpo}</svg>`;

export const ICONOS = {
  seleccionar: trazo('<path d="M5 3.5 18.5 10l-6 1.8-2.6 6.2z"/>'),
  rotar: trazo('<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4v4h-4"/>'),
  escalar: trazo('<rect x="4" y="11" width="9" height="9" rx="1"/><path d="M13 11l7-7M14.5 4H20v5.5"/>'),
  path: trazo('<path d="M12 3 7 11l2.5 7h5L17 11z"/><path d="M12 3v7"/><circle cx="12" cy="11.5" r="1.3"/><path d="M9.5 21h5"/>'),
  rect: trazo('<rect x="4" y="6" width="16" height="12" rx="1"/>'),
  ellipse: trazo('<ellipse cx="12" cy="12" rx="8" ry="6.5"/>'),
  hueso: trazo('<circle cx="6" cy="18" r="2.2"/><path d="M7.6 16.4 17.5 4.5 12.5 14.2z"/>'),
  deshacer: trazo('<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>'),
  rehacer: trazo('<path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>'),
};

export const FLECHA = `<svg class="ico-flecha" viewBox="0 0 10 10" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3.5 5 6.5 8 3.5"/></svg>`;
