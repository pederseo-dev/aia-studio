// "Connect your AI": the welcome on first launch of the desktop app, the ☰ → Connect your AI… dialog and the status
// chip in the header. The person should never have to ask the AI chat to "go connect the MCP": the buttons here write
// the AI client's config (server/aiRoutes.js), and the chip turns to "Claude connected" when an MCP server starts.

import { onServer } from './serverEvents.js';
import { notify } from './state.js';

/**
 * @typedef {{
 *   app: boolean,
 *   claudeDesktop: { config: string, status: 'missing' | 'current' | 'outdated' | 'invalid' } | null,
 *   servers: { pid: number, label: string }[],
 *   claudeCode: string, cursor: string, vscode: string,
 * }} AiStatus
 */

const WELCOME_KEY = 'aia:ai-welcome-seen';
/** @type {AiStatus | null} */
let status = null;
/** @type {HTMLDialogElement | null} */
let dialog = null;
// After the button wrote the config, until an MCP server shows up: the restart instructions stay visible.
let justConnected = false;

async function call(method, path = '') {
  const res = await fetch(`/api/ai${path}`, { method });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? 'Request failed');
  return data;
}

/**
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag @param {Record<string, any>} [props] @param {(Node | string)[]} [children]
 * @returns {HTMLElementTagNameMap[K]}
 */
function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

const names = (servers) => [...new Set(servers.map((s) => s.label))].join(' and ');

function renderChip() {
  const chip = /** @type {HTMLButtonElement} */ (document.querySelector('#ai-status'));
  if (!status) return;
  const on = status.servers.length > 0;
  chip.hidden = false;
  chip.className = on ? 'on' : '';
  chip.textContent = on ? `● ${names(status.servers)} connected` : '○ Connect your AI';
  chip.title = on ? 'The AI can see and edit your documents. Click for details' : 'No AI is connected right now. Click to connect one';
}

function claudeDesktopSection() {
  const section = el('section', { className: 'ai-client' }, [el('h3', { textContent: 'Claude Desktop' })]);
  const cd = status.claudeDesktop;
  if (!cd) {
    section.append(
      el('p', {}, ['Claude Desktop isn’t installed on this computer. Get it at ', el('a', { href: 'https://claude.ai/download', target: '_blank', rel: 'noopener', textContent: 'claude.ai/download' }), ', open it once, then come back.']),
      el('div', { className: 'buttons' }, [el('button', { type: 'button', textContent: 'Check again', onclick: refresh })]),
    );
    return section;
  }
  const connected = cd.status === 'current';
  const running = status.servers.some((s) => s.label === 'Claude Desktop');
  const text = {
    missing: 'Not connected yet. One click adds aia-studio to Claude Desktop’s settings; your other connections stay as they are.',
    current: running ? 'Connected: Claude can see and edit your documents.' : 'Set up in Claude Desktop’s settings.',
    outdated: 'Set up for another copy of aia-studio. Update it to use this one.',
    invalid: 'Claude Desktop’s settings file isn’t valid JSON, so it wasn’t touched. Fix or remove it, then try again.',
  }[cd.status];
  section.append(el('p', { textContent: text }));
  if ((connected && !running) || justConnected) {
    section.append(
      el('ol', { className: 'ai-steps' }, [
        el('li', { textContent: 'Fully quit Claude Desktop. Closing the window isn’t enough: on Windows, right-click its icon in the taskbar tray (bottom right) → Quit; on macOS, Claude → Quit Claude.' }),
        el('li', { textContent: 'Open Claude Desktop again.' }),
        el('li', { textContent: 'Ask Claude something like “Draw a robot in aia-studio”. It will show up here as it works.' }),
      ]),
    );
  }
  const buttons = el('div', { className: 'buttons' });
  if (cd.status === 'missing' || cd.status === 'outdated') {
    buttons.append(el('button', { type: 'button', className: 'main', textContent: cd.status === 'missing' ? 'Connect to Claude Desktop' : 'Update connection', onclick: () => change('POST') }));
  }
  if (connected) buttons.append(el('button', { type: 'button', textContent: 'Disconnect', onclick: () => change('DELETE') }));
  if (cd.status === 'invalid') buttons.append(el('button', { type: 'button', textContent: 'Check again', onclick: refresh }));
  section.append(buttons, el('p', { className: 'help', textContent: `Settings file: ${cd.config}` }));
  return section;
}

function otherClients() {
  const command = el('code', { textContent: status.claudeCode });
  const copy = el('button', {
    type: 'button',
    textContent: 'Copy command',
    onclick: async () => {
      await navigator.clipboard.writeText(status.claudeCode);
      copy.textContent = 'Copied';
      setTimeout(() => (copy.textContent = 'Copy command'), 1500);
    },
  });
  const link = (href, text) => el('a', { href, target: '_blank', rel: 'noopener', className: 'button', textContent: text });
  return [
    el('section', { className: 'ai-client' }, [
      el('h3', { textContent: 'Claude Code' }),
      el('p', { textContent: 'Run this once in a terminal:' }),
      el('div', { className: 'ai-command' }, [command, copy]),
    ]),
    el('section', { className: 'ai-client' }, [
      el('h3', { textContent: 'Cursor and VS Code' }),
      el('div', { className: 'buttons' }, [link(status.cursor, 'Add to Cursor'), link(status.vscode, 'Add to VS Code')]),
    ]),
    el('section', { className: 'ai-client unavailable' }, [
      el('h3', { textContent: 'ChatGPT and claude.ai on the web' }),
      el('p', { textContent: 'Not available: they can only reach servers on the internet, and aia-studio stays on your computer.' }),
    ]),
  ];
}

function renderDialog() {
  if (!dialog || !status) return;
  const welcome = dialog.dataset.welcome === 'true';
  const on = status.servers.length > 0;
  dialog.replaceChildren(
    el('h2', { textContent: welcome ? 'Welcome to aia-studio' : 'Connect your AI' }),
    el('p', {
      textContent: welcome
        ? 'aia-studio is made to work with the AI you already use: it draws and animates here while you watch and touch up. It all runs on this computer, with no API key or account.'
        : 'aia-studio works with the AI you already use. It all runs on this computer, with no API key or account.',
    }),
    el('p', { className: on ? 'ai-now on' : 'ai-now', textContent: on ? `● ${names(status.servers)} connected right now` : '○ No AI is connected right now' }),
    claudeDesktopSection(),
    ...otherClients(),
    el('form', { method: 'dialog' }, [el('button', { textContent: welcome ? 'Later' : 'Close' })]),
  );
}

async function refresh() {
  try {
    status = await call('GET');
    if (status.servers.some((s) => s.label === 'Claude Desktop')) justConnected = false;
  } catch (e) {
    return notify(e.message, true);
  }
  renderChip();
  renderDialog();
}

async function change(method) {
  try {
    status = await call(method, '/claude-desktop');
    justConnected = method === 'POST';
    notify(method === 'POST' ? 'aia-studio added to Claude Desktop. Quit and reopen Claude Desktop to finish' : 'aia-studio removed from Claude Desktop');
  } catch (e) {
    notify(e.message, true);
  }
  renderChip();
  renderDialog();
}

/** Opens the dialog. `welcome`: the first-launch version. */
export async function showConnectAi({ welcome = false } = {}) {
  if (!dialog) {
    dialog = el('dialog', { className: 'connect-ai' });
    dialog.addEventListener('close', () => {
      dialog.remove();
      dialog = null;
    });
  }
  dialog.dataset.welcome = String(welcome);
  document.body.append(dialog);
  if (!status) await refresh();
  else renderDialog();
  if (!dialog.open) dialog.showModal();
  refresh();
}

export async function mountConnectAi() {
  document.querySelector('#ai-status').addEventListener('click', () => showConnectAi());
  onServer('ai', refresh);
  await refresh();
  if (!status?.app) return;
  let seen = false;
  try {
    seen = localStorage.getItem(WELCOME_KEY) === '1';
    localStorage.setItem(WELCOME_KEY, '1');
  } catch {}
  // First launch of the desktop app, and nothing connected yet: the welcome.
  if (!seen && !status.servers.length && status.claudeDesktop?.status !== 'current') showConnectAi({ welcome: true });
}
