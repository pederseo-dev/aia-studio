// The editor's entry point. Empty for now: it only shows that the page reaches the local server.

const status = /** @type {HTMLElement} */ (document.getElementById('status'));

try {
  const response = await fetch('/api/status');
  /** @type {{ version: string, documents: string }} */
  const { version, documents } = await response.json();
  status.textContent = `Version ${version} · documents in ${documents}`;
} catch {
  status.textContent = 'The local server did not answer.';
}
