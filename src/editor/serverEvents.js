// What changed on disk, as the server streams it (server/events.js) over Server-Sent Events, in `npm run dev` and in
// the desktop app alike. EventSource reconnects by itself if the server restarts.

const source = new EventSource('/api/events');

/** @param {'document' | 'history' | 'deleted' | 'ai'} event @param {(data: any) => void} fn */
export const onServer = (event, fn) => source.addEventListener(event, (e) => fn(JSON.parse(/** @type {MessageEvent} */ (e).data)));
