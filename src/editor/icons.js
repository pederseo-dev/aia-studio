// Line icons (1.5 stroke in a 24 box, in the text color). Elements with data-icon="name" get theirs on start.

/** @param {string} body */
const stroke = (body) =>
  `<svg class="ico" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

// A bean, as v1's Fill and Stroke icons: the fill and stroke swatches draw it (colorSwatch.js).
export const BEAN = 'M4 12.5c0-3.6 2.4-6 5.3-6 1.8 0 2.5 1.1 3.9 1.1s2.1-1.1 3.9-1.1c2.4 0 3.9 2.2 3.9 4.9 0 4.3-4.1 7.1-8.9 7.1-4.3 0-8.1-2.5-8.1-6z';

export const ICONS = {
  menu: stroke('<path d="M4.5 7h15M4.5 12h15M4.5 17h15"/>'),
  add: stroke('<path d="M12 6v12M6 12h12"/>'),
  close: stroke('<path d="M7 7l10 10M17 7 7 17"/>'),
  folderPlus: stroke('<path d="M20.5 11V9.5a1 1 0 0 0-1-1h-8l-2-3h-5a1 1 0 0 0-1 1V18a1 1 0 0 0 1 1h8.5"/><path d="M18 14v6M15 17h6"/>'),
  delete: stroke('<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5M10 11v5M14 11v5"/>'),
  group: stroke('<path d="M3.5 7.5V18a1 1 0 0 0 1 1h15a1 1 0 0 0 1-1V9.5a1 1 0 0 0-1-1h-8l-2-3h-5a1 1 0 0 0-1 1z"/>'),
  vector: stroke('<path d="M5 18.5C7.5 9 16.5 9 19 18.5"/><path d="M6.5 11.5h11"/><circle cx="6.5" cy="11.5" r="1.2" fill="currentColor"/><circle cx="17.5" cy="11.5" r="1.2" fill="currentColor"/><rect x="3.3" y="17" width="3.4" height="3.4" fill="currentColor"/><rect x="17.3" y="17" width="3.4" height="3.4" fill="currentColor"/>'),
  image: stroke('<rect x="3.5" y="5" width="17" height="14" rx="1.5"/><circle cx="9" cy="10" r="1.6"/><path d="m4 17.5 5-5 3.5 3.5 2.5-2.5 5 4.5"/>'),
  eye: stroke('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>'),
  eyeOff: stroke('<path d="M4 4l16 16"/><path d="M9.6 6A10 10 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.9 3.6M6.3 7.6A17 17 0 0 0 2.5 12S6 18.5 12 18.5c1.6 0 3-.4 4.2-1"/>'),
  lock: stroke('<rect x="5.5" y="10.5" width="13" height="9.5" rx="1.5"/><path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3"/>'),
  openLock: stroke('<rect x="5.5" y="10.5" width="13" height="9.5" rx="1.5"/><path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 6.8-1.2"/>'),
  copy: stroke('<rect x="8" y="8" width="12" height="12" rx="1.5"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/>'),
  chevron: stroke('<path d="m9 6 6 6-6 6"/>'),
  select: stroke('<path d="M5 3.5 18.5 10l-6 1.8-2.6 6.2z"/>'),
  move: stroke('<path d="M12 3v18M3 12h18"/><path d="m9 6 3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3"/>'),
  scale: stroke('<rect x="4" y="11" width="9" height="9" rx="1"/><path d="M13 11l7-7M14.5 4H20v5.5"/>'),
  rotate: stroke('<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4v4h-4"/>'),
  rect: stroke('<rect x="4" y="6" width="16" height="12" rx="1"/>'),
  ellipse: stroke('<ellipse cx="12" cy="12" rx="8" ry="6.5"/>'),
  pen: stroke('<path d="M12 3 7 11l2.5 7h5L17 11z"/><path d="M12 3v7"/><circle cx="12" cy="11.5" r="1.3"/><path d="M9.5 21h5"/>'),
  points: stroke('<path d="M5 18 9 6l10 4-4 9z" stroke-dasharray="2 2"/><rect x="3.5" y="16.5" width="3" height="3" fill="currentColor"/><rect x="7.5" y="4.5" width="3" height="3" fill="currentColor"/><rect x="17.5" y="8.5" width="3" height="3" fill="currentColor"/><rect x="13.5" y="17.5" width="3" height="3" fill="currentColor"/>'),
  weld: stroke('<path d="M4 17c3 0 5-2 7-5M20 17c-3 0-5-2-7-5"/><circle cx="12" cy="11" r="2.2" fill="currentColor"/>'),
  unweld: stroke('<path d="M3.5 17c3 0 4.5-2 6-4.5M20.5 17c-3 0-4.5-2-6-4.5"/><circle cx="9.5" cy="11" r="1.8" fill="currentColor"/><circle cx="14.5" cy="11" r="1.8" fill="currentColor"/>'),
  // Add point: a curved line with a point on it and a plus.
  addPoint: stroke('<path d="M3.5 18c3-8 8-10 12-8"/><rect x="8.3" y="10.8" width="3" height="3" fill="currentColor"/><path d="M18 3.5v6M15 6.5h6"/>'),
  check: stroke('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
  corner: stroke('<path d="M5 19 12 6l7 13"/><rect x="10.5" y="4.5" width="3" height="3" fill="currentColor"/>'),
  curve: stroke('<path d="M5 19C7 9 17 9 19 19"/><path d="M6 10h12" stroke-dasharray="2 2"/><rect x="10.5" y="9.5" width="3" height="3" fill="currentColor"/>'),
  // Fill & Stroke: the bean of the fill and stroke swatches.
  bean: stroke(`<path d="${BEAN}" transform="rotate(-30 12 12)"/>`),
  path: stroke('<path d="M4 17c3-9 6-11 9-6s5 3 7-4"/><circle cx="4" cy="17" r="1.3" fill="currentColor"/><circle cx="20" cy="7" r="1.3" fill="currentColor"/>'),
};

/** @param {keyof typeof ICONS} name */
export const icon = (name) => ICONS[name];

/** Fills every element with data-icon under `root`. @param {ParentNode} root */
export function placeIcons(root) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    const name = /** @type {keyof typeof ICONS} */ (el.getAttribute('data-icon'));
    if (ICONS[name]) el.insertAdjacentHTML('afterbegin', ICONS[name]);
  }
}
