// Keeps web pages out of the local server. It has no authentication because only the person at this computer should
// reach it, so it refuses two things a page on the internet could do through the person's browser:
// - a request whose Host is not this machine (DNS rebinding: a page points its own domain at 127.0.0.1),
// - a request sent by a page of another site (a foreign Origin, or Sec-Fetch-Site: cross-site).
// The desktop app's server (server/app.js) and the Vite dev server (server/vitePlugin.js) both use it.

/**
 * Whether the Host header names this machine.
 * @param {string | undefined} host
 */
export function isLocalHost(host) {
  const name = (host ?? '')
    .toLowerCase()
    .replace(/:\d+$/, '');
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]';
}

/**
 * Whether a request comes from a page of another site. Pages served by this same server (same host and port) and
 * tools without a browser (no Origin) get through.
 * @param {{ headers: import('node:http').IncomingHttpHeaders }} req
 */
export function isCrossSite(req) {
  const origin = req.headers.origin;
  if (!origin) return req.headers['sec-fetch-site'] === 'cross-site';
  try {
    return new URL(origin).host !== req.headers.host;
  } catch {
    return true;
  }
}

/**
 * Why a request is refused, or null if it may go on.
 * @param {{ headers: import('node:http').IncomingHttpHeaders }} req
 * @returns {string | null}
 */
export function refusal(req) {
  if (!isLocalHost(req.headers.host)) return 'Only local requests are allowed';
  if (isCrossSite(req)) return 'Requests from other sites are not allowed';
  return null;
}
