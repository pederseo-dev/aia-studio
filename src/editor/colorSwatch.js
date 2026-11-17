// A color swatch: a small square with the color (crossed out when there is none). A click opens a popover to pick a
// color (a palette, the system's picker and a hex field), to take the color off (the crossed-out chip, first in the
// palette) and, when the swatch has an opacity, to set it with a slider. While they are being picked, `onInput` lets
// the canvas show them live; `onChange` saves them.

/**
 * @typedef {{
 *   value: string | null | undefined,
 *   nullable?: boolean,
 *   mixed?: boolean,
 *   opacity?: number | null,
 *   title?: string,
 *   onInput?: (color: string | null, opacity?: number) => void,
 *   onChange: (color: string | null, opacity?: number) => void,
 *   onCancel?: () => void,
 * }} SwatchOptions
 */

const PALETTE = [
  '#ffffff', '#c8c2d4', '#9a9187', '#2b2926', '#000000', '#f4d35e',
  '#f4a261', '#e76f51', '#e88aa0', '#8fc7e8', '#7fd4ec', '#7ed492',
];

const popover = document.createElement('div');
popover.className = 'color-popover';
popover.hidden = true;
popover.setAttribute('role', 'dialog');
popover.setAttribute('aria-label', 'Pick a color');
document.body.append(popover);

/** @type {(SwatchOptions & { color: string | null, alpha: number | undefined, anchor: HTMLElement }) | null} what the popover is editing */
let open = null;

function close(save = false) {
  if (!open) return;
  const current = open;
  open = null;
  popover.hidden = true;
  // Nothing is saved when the color did not change (no empty step in the history).
  const changed = current.color !== (current.value ?? null) || current.alpha !== (current.opacity ?? undefined) || current.mixed;
  if (save && changed) current.onChange(current.color, current.alpha);
  else current.onCancel?.();
}

document.addEventListener('pointerdown', (event) => {
  const target = /** @type {Node} */ (event.target);
  if (open && !popover.contains(target) && !(target instanceof Element && target.closest('.swatch'))) close(true);
});
document.addEventListener('keydown', (event) => {
  if (!open) return;
  if (event.key === 'Escape') {
    event.stopPropagation();
    close(false);
  }
});

/** @param {HTMLElement} anchor @param {SwatchOptions} options */
function openFor(anchor, options) {
  if (open) close(true);
  open = { ...options, color: options.value ?? null, alpha: options.opacity ?? undefined, anchor };
  const state = open;
  popover.replaceChildren();

  const set = (/** @type {string | null} */ color, /** @type {boolean} */ commit) => {
    state.color = color;
    picker.value = color ?? picker.value;
    hex.value = color ?? 'none';
    if (commit) close(true);
    else state.onInput?.(color, state.alpha);
  };

  const palette = document.createElement('div');
  palette.className = 'palette';
  if (options.nullable) {
    const none = document.createElement('button');
    none.type = 'button';
    none.className = 'chip none';
    none.title = 'None: take the color off';
    none.setAttribute('aria-label', 'None');
    none.addEventListener('click', () => set(null, true));
    palette.append(none);
  }
  for (const color of options.nullable ? PALETTE.slice(1) : PALETTE) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.style.background = color;
    chip.title = color;
    chip.addEventListener('click', () => set(color, true));
    palette.append(chip);
  }

  const row = document.createElement('div');
  row.className = 'row';
  const picker = document.createElement('input');
  picker.type = 'color';
  picker.value = options.value ?? '#c8c2d4';
  picker.addEventListener('input', () => set(picker.value, false));
  const hex = document.createElement('input');
  hex.type = 'text';
  hex.className = 'hex';
  hex.spellcheck = false;
  hex.value = options.mixed ? '' : (options.value ?? 'none');
  hex.placeholder = options.mixed ? 'mixed' : '';
  hex.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    const text = hex.value.trim().toLowerCase();
    if (text === 'none' && options.nullable) set(null, true);
    else if (/^#?[0-9a-f]{6}$/.test(text)) set(text.startsWith('#') ? text : `#${text}`, true);
  });
  row.append(picker, hex);

  /** @type {HTMLElement[]} */
  const extra = [];
  if (options.opacity !== undefined) {
    const line = document.createElement('div');
    line.className = 'row opacity';
    line.title = 'Opacity: 0 is invisible, 100 is solid';
    const label = document.createElement('span');
    label.textContent = 'Opacity';
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.step = '1';
    const percent = document.createElement('input');
    percent.type = 'number';
    percent.min = '0';
    percent.max = '100';
    percent.step = '1';
    const start = options.opacity === null ? '' : String(Math.round((options.opacity ?? 1) * 100));
    slider.value = start || '100';
    percent.value = start;
    percent.placeholder = options.opacity === null ? 'mixed' : '';
    const setAlpha = (/** @type {string} */ text, /** @type {HTMLInputElement} */ from) => {
      const n = Number(text);
      if (text === '' || !Number.isFinite(n)) return;
      const value = Math.min(100, Math.max(0, n));
      if (from !== slider) slider.value = String(value);
      if (from !== percent) percent.value = String(value);
      state.alpha = value / 100;
      state.onInput?.(state.color, state.alpha);
    };
    slider.addEventListener('input', () => setAlpha(slider.value, slider));
    percent.addEventListener('input', () => setAlpha(percent.value, percent));
    const sign = document.createElement('span');
    sign.textContent = '%';
    line.append(label, slider, percent, sign);
    extra.push(line);
  }

  const buttons = document.createElement('div');
  buttons.className = 'row buttons';
  const done = document.createElement('button');
  done.type = 'button';
  done.className = 'main';
  done.textContent = 'Done';
  done.addEventListener('click', () => close(true));
  buttons.append(done);

  popover.append(palette, row, ...extra, buttons);
  popover.hidden = false;
  const box = anchor.getBoundingClientRect();
  const width = popover.offsetWidth;
  popover.style.left = `${Math.max(8, Math.min(box.left, innerWidth - width - 8))}px`;
  popover.style.top = `${Math.min(box.bottom + 6, innerHeight - popover.offsetHeight - 8)}px`;
}

/**
 * @param {SwatchOptions} options
 * @returns {HTMLButtonElement}
 */
export function colorSwatch(options) {
  const swatch = document.createElement('button');
  swatch.type = 'button';
  swatch.className = `swatch${options.value === null ? ' empty' : ''}${options.mixed ? ' mixed' : ''}`;
  swatch.title = options.title ?? (options.value === null ? 'None' : (options.value ?? ''));
  if (typeof options.value === 'string' && !options.mixed) swatch.style.setProperty('--color', options.value);
  if (typeof options.opacity === 'number' && options.opacity < 1) swatch.style.setProperty('--alpha', String(options.opacity));
  swatch.addEventListener('click', () => (open?.anchor === swatch ? close(true) : openFor(swatch, options)));
  return swatch;
}

/** Whether the popover is open (keys go to it, not to the editor). */
export const pickingColor = () => !!open;
