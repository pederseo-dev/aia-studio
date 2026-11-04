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
  // Hueso clásico en diagonal (dos nudos en cada punta) para que no se confunda con un pincel.
  hueso: trazo('<path transform="rotate(-45 12 12)" d="M8 10.2h8a2.4 2.4 0 1 1 3.2 1.8 2.4 2.4 0 1 1-3.2 1.8H8a2.4 2.4 0 1 1-3.2-1.8A2.4 2.4 0 1 1 8 10.2z"/>'),
  deshacer: trazo('<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>'),
  rehacer: trazo('<path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>'),
  group: trazo('<path d="M3.5 7.5V18a1 1 0 0 0 1 1h15a1 1 0 0 0 1-1V9.5a1 1 0 0 0-1-1h-8l-2-3h-5a1 1 0 0 0-1 1z"/>'),
  switch: trazo('<path d="M4 8h13M14 4.5 17.5 8 14 11.5"/><path d="M20 16H7M10 12.5 6.5 16l3.5 3.5"/>'),
  duplicar: trazo('<rect x="8" y="8" width="12" height="12" rx="1.5"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/>'),
  borrar: trazo('<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5M10 11v5M14 11v5"/>'),
  estilo: trazo('<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 0 0 16z" fill="currentColor"/>'),
  degradado: trazo('<rect x="4" y="4" width="16" height="16" rx="1.5"/><path d="M8 4v16M12 4v16M16 4v16" stroke-dasharray="2 2"/>'),
  agregar: trazo('<path d="M12 6v12M6 12h12"/>'),
};

export const FLECHA = `<svg class="ico-flecha" viewBox="0 0 10 10" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3.5 5 6.5 8 3.5"/></svg>`;
