// The local API (server/api.js), as functions. Errors come back as thrown Errors with the server's message.

/**
 * @typedef {import('../core/document.js').Doc} Doc
 * @typedef {import('../core/operations.js').Operation} Operation
 * @typedef {{ document: Doc, canUndo: boolean, canRedo: boolean }} DocumentState
 */

/** @param {string} path @param {{ method?: string, body?: unknown }} [options] */
async function call(path, { method = 'GET', body } = {}) {
  const response = await fetch(`/api/${path}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? `${response.status} ${response.statusText}`);
  return data;
}

const doc = (/** @type {string} */ id) => `documents/${encodeURIComponent(id)}`;

export const api = {
  /** @returns {Promise<{ id: string, name: string }[]>} */
  list: () => call('documents'),
  /** @param {Record<string, unknown>} meta @returns {Promise<{ id: string } & DocumentState>} */
  create: (meta) => call('documents', { method: 'POST', body: meta }),
  /** @param {string} id @returns {Promise<DocumentState>} */
  get: (id) => call(doc(id)),
  /** @param {string} id */
  remove: (id) => call(doc(id), { method: 'DELETE' }),
  /** @param {string} id @param {Operation[]} ops @param {string} [note] @returns {Promise<DocumentState>} */
  ops: (id, ops, note) => call(`${doc(id)}/ops`, { method: 'POST', body: { ops, note } }),
  /** @param {string} id @param {boolean} [skip] drop the step instead (one that cannot be undone) @returns {Promise<DocumentState>} */
  undo: (id, skip = false) => call(`${doc(id)}/undo`, { method: 'POST', body: skip ? { skip: true } : {} }),
  /** @param {string} id @returns {Promise<DocumentState>} */
  redo: (id) => call(`${doc(id)}/redo`, { method: 'POST' }),
};
