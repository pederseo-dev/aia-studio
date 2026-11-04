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
  // Herramientas de huesos: crear (hueso con un +) y manipular (hueso con una flecha de giro).
  agregarHueso: trazo('<path transform="rotate(-45 11 13)" d="M7 11.2h8a2.4 2.4 0 1 1 3.2 1.8 2.4 2.4 0 1 1-3.2 1.8H7a2.4 2.4 0 1 1-3.2-1.8A2.4 2.4 0 1 1 7 11.2z"/><path d="M19 2.5v5M16.5 5h5"/>'),
  manipular: trazo('<path d="M4.5 19.5 14 10"/><circle cx="4.5" cy="19.5" r="1.8"/><circle cx="14" cy="10" r="1.3"/><path d="M11 3.8a8 8 0 0 1 9.2 9.2"/><path d="m20.2 9.5 0 3.5-3.5 0"/>'),
  // Reparent Bone, Bind Layer y Bind Points.
  reparentar: trazo('<path d="M5 19 12 12"/><circle cx="12" cy="12" r="1.3"/><path d="M12 12l6-6"/><path d="M8 7.5c0-2 1.5-3.5 3.5-3.5"/><path d="m10 2.5 1.5 1.5L10 5.5"/><circle cx="5" cy="19" r="1.6"/>'),
  enlazarCapa: trazo('<rect x="3.5" y="12" width="9" height="8" rx="1"/><path d="M14 13 20 5"/><circle cx="20" cy="5" r="1.4"/><path d="M8 12V9.5a2 2 0 0 1 4 0"/>'),
  enlazarPuntos: trazo('<path d="M14 13 20 5"/><circle cx="20" cy="5" r="1.4"/><circle cx="5" cy="17" r="1.6" fill="currentColor"/><circle cx="10" cy="20" r="1.6" fill="currentColor"/><circle cx="6" cy="10.5" r="1.6"/><path d="M7 16.5 12 13"/>'),
  deshacer: trazo('<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>'),
  rehacer: trazo('<path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>'),
  group: trazo('<path d="M3.5 7.5V18a1 1 0 0 0 1 1h15a1 1 0 0 0 1-1V9.5a1 1 0 0 0-1-1h-8l-2-3h-5a1 1 0 0 0-1 1z"/>'),
  // Carpeta con un hueso: la capa de huesos.
  skeleton: trazo('<path d="M3.5 7.5V18a1 1 0 0 0 1 1h15a1 1 0 0 0 1-1V9.5a1 1 0 0 0-1-1h-8l-2-3h-5a1 1 0 0 0-1 1z"/><path d="M9 15.5l6-3"/><circle cx="8.2" cy="15.9" r="1.1"/><circle cx="15.8" cy="12.1" r="1.1"/>'),
  switch: trazo('<path d="M4 8h13M14 4.5 17.5 8 14 11.5"/><path d="M20 16H7M10 12.5 6.5 16l3.5 3.5"/>'),
  duplicar: trazo('<rect x="8" y="8" width="12" height="12" rx="1.5"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/>'),
  borrar: trazo('<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5M10 11v5M14 11v5"/>'),
  estilo: trazo('<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 0 0 16z" fill="currentColor"/>'),
  degradado: trazo('<rect x="4" y="4" width="16" height="16" rx="1.5"/><path d="M8 4v16M12 4v16M16 4v16" stroke-dasharray="2 2"/>'),
  agregar: trazo('<path d="M12 6v12M6 12h12"/>'),
  radial: trazo('<rect x="4" y="4" width="16" height="16" rx="1.5"/><circle cx="12" cy="12" r="2.5"/><circle cx="12" cy="12" r="5.5" stroke-dasharray="2 2"/>'),
  pose: trazo('<circle cx="12" cy="5" r="2"/><path d="M12 7.5v6.5M7 10.5l5-2 5 2M9 20l3-6 3 6"/>'),
  param: trazo('<path d="M4 12h16"/><circle cx="14" cy="12" r="2.5" fill="currentColor"/>'),
  driver: trazo('<path d="M4 17c4 0 4-10 8-10s4 10 8 10"/><circle cx="12" cy="7" r="1.3" fill="currentColor"/>'),
};

// Ícono de cada tipo de objeto, para la jerarquía y los recursos.
export const ICONO_DE_TIPO = {
  group: ICONOS.group, switch: ICONOS.switch, skeleton: ICONOS.skeleton, rect: ICONOS.rect, ellipse: ICONOS.ellipse, path: ICONOS.path,
  bone: ICONOS.hueso, style: ICONOS.estilo, linear_gradient: ICONOS.degradado, radial_gradient: ICONOS.radial,
  pose: ICONOS.pose, param: ICONOS.param, driver: ICONOS.driver,
};

export const FLECHA = `<svg class="ico-flecha" viewBox="0 0 10 10" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3.5 5 6.5 8 3.5"/></svg>`;
