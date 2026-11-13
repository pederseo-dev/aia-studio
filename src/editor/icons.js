// Line icons for the toolbar (1.5 stroke in a 24 box, text color).

const stroke = (body) =>
  `<svg class="ico" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const BONE = 'M8 10.2h8a2.4 2.4 0 1 1 3.2 1.8 2.4 2.4 0 1 1-3.2 1.8H8a2.4 2.4 0 1 1-3.2-1.8A2.4 2.4 0 1 1 8 10.2z';
// The shrunk bone in the top-left corner, with the same stroke width as the rest.
const smallBone = `<path transform="translate(9 9) scale(0.72) translate(-12 -12) rotate(-45 12 12)" stroke-width="2.1" d="${BONE}"/>`;

export const ICONOS = {
  select: stroke('<path d="M5 3.5 18.5 10l-6 1.8-2.6 6.2z"/>'),
  rotate: stroke('<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4v4h-4"/>'),
  scale: stroke('<rect x="4" y="11" width="9" height="9" rx="1"/><path d="M13 11l7-7M14.5 4H20v5.5"/>'),
  path: stroke('<path d="M12 3 7 11l2.5 7h5L17 11z"/><path d="M12 3v7"/><circle cx="12" cy="11.5" r="1.3"/><path d="M9.5 21h5"/>'),
  // Frame with the corner crop lines: the canvas (artboard).
  artboard: stroke('<rect x="6.5" y="6.5" width="11" height="11"/><path d="M6.5 2.5v2M6.5 19.5v2M17.5 2.5v2M17.5 19.5v2M2.5 6.5h2M19.5 6.5h2M2.5 17.5h2M19.5 17.5h2"/>'),
  rect: stroke('<rect x="4" y="6" width="16" height="12" rx="1"/>'),
  ellipse: stroke('<ellipse cx="12" cy="12" rx="8" ry="6.5"/>'),
  // Classic diagonal bone (two knobs at each end) so it is not confused with a brush.
  bone: stroke('<path transform="rotate(-45 12 12)" d="M8 10.2h8a2.4 2.4 0 1 1 3.2 1.8 2.4 2.4 0 1 1-3.2 1.8H8a2.4 2.4 0 1 1-3.2-1.8A2.4 2.4 0 1 1 8 10.2z"/>'),
  // Bone tool family: the same small bone at the top left and, at the bottom right, the mark of
  // what each one does (+ create, rotation manipulate, branch reparent, layers bind layer, points bind points).
  addBone: stroke(`${smallBone}<path d="M17.5 14v7M14 17.5h7"/>`),
  manipulate: stroke(`${smallBone}<path d="M20.5 15.2a3.6 3.6 0 1 0 .5 3.3"/><path d="M20.8 12.8v2.7h-2.7"/>`),
  reparent: stroke(`${smallBone}<path d="M14 13.5v5a1.5 1.5 0 0 0 1.5 1.5H21"/><path d="m19 18 2 2-2 2"/>`),
  bindLayer: stroke(`${smallBone}<path d="m13.5 16.5 4-2.2 4 2.2-4 2.2z"/><path d="m13.5 19.3 4 2.2 4-2.2"/>`),
  bindPoints: stroke(`${smallBone}<path d="M14.5 20.5 17.5 15l3.5 4.5" stroke-width="1"/><circle cx="14.5" cy="20.5" r="1.4" fill="currentColor"/><circle cx="17.5" cy="15" r="1.4" fill="currentColor"/><circle cx="21" cy="19.5" r="1.4" fill="currentColor"/>`),
  undo: stroke('<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>'),
  redo: stroke('<path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>'),
  group: stroke('<path d="M3.5 7.5V18a1 1 0 0 0 1 1h15a1 1 0 0 0 1-1V9.5a1 1 0 0 0-1-1h-8l-2-3h-5a1 1 0 0 0-1 1z"/>'),
  // Folder with a bone: the bone layer.
  skeleton: stroke('<path d="M3.5 7.5V18a1 1 0 0 0 1 1h15a1 1 0 0 0 1-1V9.5a1 1 0 0 0-1-1h-8l-2-3h-5a1 1 0 0 0-1 1z"/><path d="M9 15.5l6-3"/><circle cx="8.2" cy="15.9" r="1.1"/><circle cx="15.8" cy="12.1" r="1.1"/>'),
  switch: stroke('<path d="M4 8h13M14 4.5 17.5 8 14 11.5"/><path d="M20 16H7M10 12.5 6.5 16l3.5 3.5"/>'),
  duplicate: stroke('<rect x="8" y="8" width="12" height="12" rx="1.5"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/>'),
  // Layer lock (Layers): closed = locked on the canvas.
  lock: stroke('<rect x="5.5" y="10.5" width="13" height="9.5" rx="1.5"/><path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3"/>'),
  openLock: stroke('<rect x="5.5" y="10.5" width="13" height="9.5" rx="1.5"/><path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 6.8-1.2"/>'),
  delete: stroke('<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5M10 11v5M14 11v5"/>'),
  style: stroke('<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 0 0 16z" fill="currentColor"/>'),
  gradient: stroke('<rect x="4" y="4" width="16" height="16" rx="1.5"/><path d="M8 4v16M12 4v16M16 4v16" stroke-dasharray="2 2"/>'),
  add: stroke('<path d="M12 6v12M6 12h12"/>'),
  folderPlus: stroke('<path d="M20.5 11V9.5a1 1 0 0 0-1-1h-8l-2-3h-5a1 1 0 0 0-1 1V18a1 1 0 0 0 1 1h8.5"/><path d="M18 14v6M15 17h6"/>'),
  menu: stroke('<path d="M4.5 7h15M4.5 12h15M4.5 17h15"/>'),
  radial: stroke('<rect x="4" y="4" width="16" height="16" rx="1.5"/><circle cx="12" cy="12" r="2.5"/><circle cx="12" cy="12" r="5.5" stroke-dasharray="2 2"/>'),
  pose: stroke('<circle cx="12" cy="5" r="2"/><path d="M12 7.5v6.5M7 10.5l5-2 5 2M9 20l3-6 3 6"/>'),
  param: stroke('<path d="M4 12h16"/><circle cx="14" cy="12" r="2.5" fill="currentColor"/>'),
  driver: stroke('<path d="M4 17c4 0 4-10 8-10s4 10 8 10"/><circle cx="12" cy="7" r="1.3" fill="currentColor"/>'),
  animation: stroke('<path d="M4 19h16"/><path d="M9 6v8l6-4z"/>'),
  // Frame with a mountain and a sun: the image layer.
  image: stroke('<rect x="3.5" y="5" width="17" height="14" rx="1.5"/><path d="m3.5 16.5 5-5 4 4 2.5-2.5 5.5 5"/><circle cx="15.5" cy="9.5" r="1.5"/>'),
};

// Icon of each object type, for the hierarchy and the assets.
export const TYPE_ICON = {
  group: ICONOS.group, switch: ICONOS.switch, skeleton: ICONOS.skeleton, rect: ICONOS.rect, ellipse: ICONOS.ellipse, path: ICONOS.path, image: ICONOS.image,
  bone: ICONOS.bone, style: ICONOS.style, linear_gradient: ICONOS.gradient, radial_gradient: ICONOS.radial,
  pose: ICONOS.pose, param: ICONOS.param, driver: ICONOS.driver, animation: ICONOS.animation,
};

export const FLECHA = `<svg class="ico-flecha" viewBox="0 0 10 10" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3.5 5 6.5 8 3.5"/></svg>`;
