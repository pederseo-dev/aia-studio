// The top bar: the main menu (☰), the document tabs and the dialogs the menu opens. Undo and redo are Ctrl+Z and
// Ctrl+Shift+Z (main.js).

import { api } from './api.js';
import { icon } from './icons.js';
import { close, createDocument, deleteDocument, notify, open, run, state } from './state.js';
import { forgetView, zoomFit } from './navigate.js';

const $ = (/** @type {string} */ selector) => /** @type {HTMLElement} */ (document.querySelector(selector));

/** Opens and closes dropdown menus: a button with aria-haspopup followed by its .menu. */
export function setupDropdowns() {
  document.addEventListener('click', (event) => {
    const target = /** @type {HTMLElement} */ (event.target);
    const button = target.closest('[aria-haspopup="menu"]');
    // Typing in a field inside a menu keeps it open.
    if (!button && target.closest('.menu input')) return;
    for (const menu of document.querySelectorAll('.menu')) {
      const owner = menu.previousElementSibling;
      const show = owner === button && menu.hasAttribute('hidden');
      menu.toggleAttribute('hidden', !show);
      owner?.setAttribute('aria-expanded', String(show));
    }
  });
}

/** @param {HTMLDialogElement} dialog */
function closable(dialog) {
  for (const button of dialog.querySelectorAll('[data-close]')) button.addEventListener('click', () => dialog.close());
}

const newDialog = /** @type {HTMLDialogElement} */ ($('#new-dialog'));
const openDialog = /** @type {HTMLDialogElement} */ ($('#open-dialog'));
const settingsDialog = /** @type {HTMLDialogElement} */ ($('#settings-dialog'));
const shortcutsDialog = /** @type {HTMLDialogElement} */ ($('#shortcuts-dialog'));

/** @param {HTMLDialogElement} dialog */
const form = (dialog) => /** @type {HTMLFormElement} */ (dialog.querySelector('form'));

export const actions = {
  new() {
    form(newDialog).reset();
    newDialog.showModal();
  },
  async open() {
    const list = $('#documents-list');
    list.replaceChildren();
    const documents = await api.list().catch((e) => (notify(e.message), []));
    if (documents.length === 0) list.innerHTML = '<li class="faint">No documents yet.</li>';
    for (const { id, name } of documents) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = name;
      button.title = id;
      button.addEventListener('click', () => {
        openDialog.close();
        open(id);
      });
      item.append(button);
      list.append(item);
    }
    openDialog.showModal();
  },
  settings() {
    if (!state.document) return;
    const meta = state.document.meta;
    const f = form(settingsDialog);
    const field = (/** @type {string} */ name) => /** @type {HTMLInputElement} */ (f.elements.namedItem(name));
    field('name').value = String(meta.name ?? '');
    field('width').value = String(meta.width ?? 800);
    field('height').value = String(meta.height ?? 600);
    const background = meta.background === undefined ? '#ffffff' : meta.background;
    field('background').value = typeof background === 'string' ? background : '#ffffff';
    field('transparent').checked = background === null;
    settingsDialog.showModal();
  },
  close() {
    if (state.active) close(state.active);
  },
  delete() {
    const tab = state.tabs.find((t) => t.id === state.active);
    if (tab && confirm(`Delete «${tab.name}» and its history? This cannot be undone.`)) deleteDocument(tab.id).then(() => forgetView(tab.id));
  },
  shortcuts() {
    shortcutsDialog.showModal();
  },
};

export function setupHeader() {
  for (const dialog of [newDialog, openDialog, settingsDialog, shortcutsDialog]) closable(dialog);

  document.addEventListener('click', (event) => {
    const item = /** @type {HTMLElement} */ (event.target).closest('[data-action]');
    const action = item?.getAttribute('data-action');
    if (action && action in actions) actions[/** @type {keyof typeof actions} */ (action)]();
  });
  $('#tab-new').addEventListener('click', () => actions.new());

  form(newDialog).addEventListener('submit', () => {
    const data = new FormData(form(newDialog));
    // A new document may take the id of a deleted one: it starts fitted, not with the old one's view.
    createDocument({ name: String(data.get('name')).trim(), width: Number(data.get('width')), height: Number(data.get('height')) }).then(() => zoomFit());
  });

  form(settingsDialog).addEventListener('submit', () => {
    const data = new FormData(form(settingsDialog));
    const props = {
      name: String(data.get('name')).trim(),
      width: Number(data.get('width')),
      height: Number(data.get('height')),
      background: data.get('transparent') ? null : String(data.get('background')),
    };
    run([{ op: 'set', target: 'meta', props }], { note: 'Project Settings' });
  });
}

export function renderHeader() {
  const tabs = $('#tabs');
  tabs.replaceChildren(
    ...state.tabs.map((tab) => {
      const el = document.createElement('div');
      el.className = `tab${tab.id === state.active ? ' active' : ''}`;
      el.setAttribute('role', 'tab');
      el.setAttribute('aria-selected', String(tab.id === state.active));
      el.title = tab.id;
      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = tab.name;
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'close';
      x.title = 'Close tab (Alt+W)';
      x.setAttribute('aria-label', `Close ${tab.name}`);
      x.innerHTML = icon('close');
      x.addEventListener('click', (event) => {
        event.stopPropagation();
        close(tab.id);
      });
      el.addEventListener('click', () => tab.id !== state.active && open(tab.id));
      el.append(title, x);
      return el;
    }),
  );
  $('#notice').textContent = state.notice;
  for (const item of document.querySelectorAll('[data-requires-doc]')) {
    /** @type {HTMLButtonElement} */ (item).disabled = !state.document;
  }
}
