// How a document looks, as a tree of SVG elements ({ tag, attrs, children }). It does not use the DOM, so the same
// function draws the editor's canvas (which turns it into elements), the AI's previews and, later, the runtime.
// Every part is one <path>, every image layer one <image>; hidden layers and parts are left out. Where an image's file
// is found depends on who draws: the editor asks the server, the PNG and the export put the file inside (data URLs).

import { childrenOf } from './document.js';
import { outlineOf } from './geometry.js';
import { resolveDoc } from './points.js';
import { svgTransform } from './transform.js';

/**
 * @typedef {import('./document.js').Doc} Doc
 * @typedef {import('./document.js').DocObject} DocObject
 * @typedef {import('./geometry.js').Vertex} Vertex
 * @typedef {{ tag: string, attrs: Record<string, string | number>, children: SvgNode[] }} SvgNode
 * @typedef {{ assetUrl?: (src: string) => string | null }} DrawOptions assetUrl: the href of an asset file (null: it is
 *   not there, so nothing is drawn); by default "assets/<src>", next to the document
 */

/** @param {string} src */
const besideTheDocument = (src) => `assets/${src}`;

const DEFAULTS = { fill: '#c8c2d4', stroke: '#2b2926', strokeWidth: 2 };

/** @param {number} n */
const r = (n) => Math.round(n * 100) / 100;

/**
 * SVG path data for an outline.
 * @param {Vertex[]} vertices
 * @param {boolean} closed
 */
export function pathData(vertices, closed) {
  if (vertices.length === 0) return '';
  const [first] = vertices;
  let d = `M${r(first.x)} ${r(first.y)}`;
  /** @param {Vertex} a @param {Vertex} b */
  const segment = (a, b) => {
    if (!a.out && !b.in) return `L${r(b.x)} ${r(b.y)}`;
    const c1 = { x: a.x + (a.out?.x ?? 0), y: a.y + (a.out?.y ?? 0) };
    const c2 = { x: b.x + (b.in?.x ?? 0), y: b.y + (b.in?.y ?? 0) };
    return `C${r(c1.x)} ${r(c1.y)} ${r(c2.x)} ${r(c2.y)} ${r(b.x)} ${r(b.y)}`;
  };
  for (let i = 1; i < vertices.length; i++) d += segment(vertices[i - 1], vertices[i]);
  if (closed && vertices.length > 2) {
    const last = vertices[vertices.length - 1];
    // A straight closing side is drawn by Z itself.
    d += last.out || first.in ? `${segment(last, first)}Z` : 'Z';
  }
  return d;
}

/**
 * The outline of a part as path data.
 * @param {DocObject} part
 */
export function partData(part) {
  return pathData(outlineOf(part), part.closed !== false);
}

/**
 * @param {Doc} doc
 * @param {string | null} parent
 * @param {Required<DrawOptions>} options
 * @returns {SvgNode[]}
 */
function drawChildren(doc, parent, options) {
  /** @type {SvgNode[]} */
  const nodes = [];
  for (const object of childrenOf(doc, parent)) {
    if (object.visible === false) continue;
    if (object.type === 'group' || object.type === 'vector' || object.type === 'image') {
      const transform = svgTransform(doc, object);
      const children = object.type === 'image' ? drawImage(object, options) : drawChildren(doc, object.id, options);
      nodes.push({ tag: 'g', attrs: { 'data-id': object.id, ...(transform ? { transform } : {}) }, children });
      continue;
    }
    const fill = object.fill === undefined ? DEFAULTS.fill : object.fill;
    const stroke = object.stroke === undefined ? DEFAULTS.stroke : object.stroke;
    /** @type {Record<string, string | number>} */
    const attrs = { 'data-id': object.id, d: partData(object), fill: fill === null ? 'none' : String(fill) };
    if (stroke !== null) {
      attrs.stroke = String(stroke);
      attrs['stroke-width'] = Number(object.strokeWidth ?? DEFAULTS.strokeWidth);
      attrs['stroke-linejoin'] = 'round';
      attrs['stroke-linecap'] = 'round';
    }
    nodes.push({ tag: 'path', attrs, children: [] });
  }
  return nodes;
}

/**
 * An image layer's picture, from (0, 0) to (width, height) in its own coordinates.
 * @param {DocObject} layer @param {Required<DrawOptions>} options
 * @returns {SvgNode[]}
 */
function drawImage(layer, options) {
  const href = typeof layer.src === 'string' ? options.assetUrl(layer.src) : null;
  if (!href) return [];
  /** @type {Record<string, string | number>} */
  const attrs = { href, width: Number(layer.width ?? 100), height: Number(layer.height ?? 100), preserveAspectRatio: 'none' };
  if (layer.opacity !== undefined && layer.opacity !== 1) attrs.opacity = Number(layer.opacity);
  return [{ tag: 'image', attrs, children: [] }];
}

/**
 * The drawing of a document: its artboard size and the elements inside it.
 * @param {Doc} doc
 * @param {DrawOptions} [options]
 * @returns {{ width: number, height: number, background: string | null, nodes: SvgNode[] }}
 */
export function drawDocument(doc, { assetUrl = besideTheDocument } = {}) {
  doc = resolveDoc(doc);
  const background = doc.meta.background === undefined ? '#ffffff' : doc.meta.background;
  return {
    width: Number(doc.meta.width ?? 800),
    height: Number(doc.meta.height ?? 600),
    background: background === null ? null : String(background),
    nodes: drawChildren(doc, null, { assetUrl }),
  };
}

/**
 * The drawing as SVG text (for previews and files).
 * @param {Doc} doc
 * @param {DrawOptions} [options]
 */
export function toSvg(doc, options) {
  const { width, height, background, nodes } = drawDocument(doc, options);
  /** @param {string} text */
  const escape = (text) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  /** @param {SvgNode} node @returns {string} */
  const write = (node) => {
    const attrs = Object.entries(node.attrs)
      .map(([k, v]) => ` ${k}="${escape(String(v))}"`)
      .join('');
    return node.children.length ? `<${node.tag}${attrs}>${node.children.map(write).join('')}</${node.tag}>` : `<${node.tag}${attrs}/>`;
  };
  const back = background ? `<rect width="${width}" height="${height}" fill="${background}"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${back}${nodes.map(write).join('')}</svg>`;
}
