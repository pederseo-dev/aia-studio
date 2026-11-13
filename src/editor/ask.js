// Asking for a short text (a name, a curve): the editor's own dialog instead of window.prompt(), which the desktop app
// (Electron) does not implement: there it returns null without showing anything.

/**
 * Shows a modal dialog with `message` and a text field. Resolves to the text (untrimmed), or null if cancelled
 * (Cancel, Esc or closing it).
 * @param {string} message @param {string} [initial]
 * @returns {Promise<string | null>}
 */
export function askText(message, initial = '') {
  const dialog = document.createElement('dialog');
  dialog.className = 'ask';
  const form = document.createElement('form');
  form.method = 'dialog';
  const label = document.createElement('label');
  label.textContent = message;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = initial;
  input.autocomplete = 'off';
  input.spellcheck = false;
  label.append(input);
  const buttons = document.createElement('div');
  buttons.className = 'buttons';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  const ok = document.createElement('button');
  ok.type = 'submit';
  ok.value = 'ok';
  ok.className = 'main';
  ok.textContent = 'OK';
  buttons.append(cancel, ok);
  form.append(label, buttons);
  dialog.append(form);
  document.body.append(dialog);

  return new Promise((resolve) => {
    cancel.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {
      resolve(dialog.returnValue === 'ok' ? input.value : null);
      dialog.remove();
    });
    dialog.showModal();
    input.select();
  });
}
