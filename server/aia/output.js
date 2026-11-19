// The `aia` commands of one topic. Output: a file to use elsewhere (export) and a picture to check by eye (render).

import path from 'node:path';
import { toSvg } from '../../src/core/draw.js';
import { apply as applyMatrix, verticesOf } from '../../src/core/geometry.js';
import { worldOf } from '../../src/core/transform.js';
import { resolveDoc } from '../../src/core/points.js';
import { svgToPng } from '../png.js';
import { bundleRuntime } from '../bundle.js';
import { AiaError, ok } from './common.js';

/**
 * @typedef {import('./common.js').Command} Command
 * @typedef {import('./common.js').Context} Context
 * @typedef {import('../../src/core/operations.js').Operation} Operation
 */

const RENDER_MAX = 2000;

/** @param {Context} ctx @returns {Record<string, Command>} */
export function outputCommands(ctx) {
  const { store, ORIGIN, need, number, points } = ctx;
  return {
    export: {
      usage: 'aia export <doc> --format svg|html [--out file]',
      summary: 'The document as a file to use outside aia-studio: a still SVG, or a web page that plays it',
      details:
        'svg: the drawing as it looks now. html: one page with the document and the runtime inside, which plays it in\n' +
        'any browser with no server and nothing else (the runtime is the same drawing code as the editor). From the\n' +
        'CLI the file goes to --out, or to the temp folder (the path is printed).',
      run: async (args) => {
        const id = need(args, 0, 'the document id');
        const format = args.flags.format ?? 'svg';
        if (format !== 'svg' && format !== 'html') throw new AiaError('--format is svg or html');
        const { document } = await store.get(id, ORIGIN);
        const assets = await store.assetUrls(id, document);
        const data = format === 'svg' ? toSvg(document, { assetUrl: (src) => assets[src] ?? null }) : htmlPage(document, assets);
        return { ok: true, text: `${id}.${format}: ${Math.round(data.length / 102.4) / 10} KB`, file: { name: `${id}.${format}`, data } };
      },
    },

    render: {
      usage: 'aia render <doc> [--width N] [--labels] [--out file.png]',
      summary: 'A PNG of the document, to check your work by eye',
      details:
        'The image is the artboard as the editor and the export draw it, --width px wide (its own width by default).\n' +
        'From the CLI it is saved to --out, or to aia-<doc>.png in the temp folder (the path is printed); over MCP it\n' +
        'comes back as an image. --labels marks the named points (labeled) and the shared ones (rings) where they\n' +
        'are on the artboard, to check welds and names.',
      run: async (args) => {
        const id = need(args, 0, 'the document id');
        const { document } = await store.get(id, ORIGIN);
        const docWidth = Number(document.meta.width ?? 800);
        const docHeight = Number(document.meta.height ?? 600);
        const width = Math.min(RENDER_MAX, number(args, 'width') ?? docWidth);
        const assets = await store.assetUrls(id, document);
        const drawn = toSvg(document, { assetUrl: (src) => assets[src] ?? null });
        const svg = args.flags.labels === true ? withPoints(document, drawn, docWidth / width) : drawn;
        const image = svgToPng(svg, width, { text: args.flags.labels === true });
        const height = Math.round((width * docHeight) / docWidth);
        return { ok: true, text: `${id}: ${width} × ${height} px`, image, name: `${id}.png` };
      },
    },
  };
}


/**
 * A web page that plays a document with the runtime, with nothing else to load (its pictures go inside).
 * @param {import('../../src/core/document.js').Doc} doc @param {Record<string, string>} assets data URLs by name
 */
function htmlPage(doc, assets) {
  /** @param {string} text */
  const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const json = JSON.stringify(doc).replace(/</g, '\\u003c');
  const assetJson = JSON.stringify(assets).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(String(doc.meta.name ?? 'aia-studio'))}</title>
<style>html, body { margin: 0; height: 100%; } body { display: grid; place-items: center; background: #2b2a33; } svg { max-width: 100vw; max-height: 100vh; height: auto; }</style>
</head>
<body>
<svg id="aia" xmlns="http://www.w3.org/2000/svg"></svg>
<script type="application/json" id="aia-document">${json}</script>
<script type="application/json" id="aia-assets">${assetJson}</script>
<script>
${bundleRuntime()}</script>
<script>
const read = (id) => JSON.parse(document.getElementById(id).textContent);
aiaRuntime.createPlayer(document.getElementById('aia'), read('aia-document'), { assets: read('aia-assets') });
</script>
</body>
</html>
`;
}

/**
 * The drawing with its named and shared points marked and labeled where they are on the artboard (aia render
 * --labels), to check welds and names by eye.
 * @param {import('../../src/core/document.js').Doc} doc @param {string} svg @param {number} unit document px per image px
 */
function withPoints(doc, svg, unit) {
  const shown = resolveDoc(doc);
  /** @type {string[]} */
  const marks = [];
  /** @param {string} text */
  const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  for (const part of shown.objects) {
    const w = worldOf(shown, part.id);
    for (const [i, v] of verticesOf(part).entries()) {
      if (!v.name && !v.ref) continue;
      const p = applyMatrix(w, v);
      const shared = !!v.ref;
      // A shared vertex sits on its point: only the point itself gets a label.
      marks.push(`<circle cx="${p.x}" cy="${p.y}" r="${4 * unit}" fill="${shared ? 'none' : '#e0306a'}" stroke="#e0306a" stroke-width="${1.5 * unit}"/>`);
      if (!shared) marks.push(`<text x="${p.x + 6 * unit}" y="${p.y - 6 * unit}" font-family="Arial" font-size="${11 * unit}" fill="#e0306a" stroke="#ffffff" stroke-width="${3 * unit}" paint-order="stroke">${escape(`${part.id}.${v.name}`)}</text>`);
      void i;
    }
  }
  return svg.replace(/<\/svg>$/, `${marks.join('')}</svg>`);
}
