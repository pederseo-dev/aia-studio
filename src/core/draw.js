// How a document looks, as a tree of SVG elements ({ tag, attrs, children }). It does not use the DOM, so the same
// function draws the editor's canvas (which turns it into elements), the AI's previews and, later, the runtime.
// Every part is one <path> (or a <g> with its fill and its stroke apart, when it hides stretches of its stroke), every
// image layer one <image>; hidden layers and parts are left out. Where an image's file
// is found depends on who draws: the editor asks the server, the PNG and the export put the file inside (data URLs).

import { childrenOf } from './document.js';
import { holeOutlinesOf, outlineOf, stretchesIn } from './geometry.js';
import { resolveDoc, strokedOutlines } from './points.js';
import { hiddenFlags, hidesEdges } from './edges.js';
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

/** What a part draws with where it sets nothing (the schema's defaults). */
export const DEFAULTS = { fill: '#c8c2d4', stroke: '#2b2926', strokeWidth: 2, strokeCap: 'round', strokeJoin: 'round' };

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
 * The outline of a part as path data, with its holes after it (drawn with the even-odd rule, so they cut the fill).
 * @param {DocObject} part
 */
export function partData(part) {
  const closed = part.closed !== false;
  const holes = closed ? holeOutlinesOf(part) : [];
  return pathData(outlineOf(part), closed) + holes.map((hole) => pathData(hole, true)).join('');
}

/**
 * The stroke of a part that hides some of its stretches, as path data: each outline in runs of shown stretches (a
 * closed outline is opened where a stretch is hidden).
 * @param {DocObject} part resolved
 */
function strokeData(part) {
  return strokedOutlines(part)
    .map((outline) => {
      const hidden = hiddenFlags(part, outline);
      const { vertices, closed } = outline;
      if (!hidden.some(Boolean)) return pathData(vertices, closed);
      const n = vertices.length;
      const count = stretchesIn(n, closed);
      // A closed outline starts after a hidden stretch, so no run goes over its end.
      const start = count === n ? hidden.indexOf(true) + 1 : 0;
      let d = '';
      /** @type {Vertex[]} */
      let run = [];
      for (let j = 0; j < count; j++) {
        const k = (start + j) % count;
        if (hidden[k]) {
          if (run.length) d += pathData(run, false);
          run = [];
          continue;
        }
        if (!run.length) run.push(vertices[k]);
        run.push(vertices[(k + 1) % n]);
      }
      return d + (run.length ? pathData(run, false) : '');
    })
    .join('');
}

/**
 * A part: one <path> with its fill and stroke; or, when it hides stretches of its stroke, a <g> with the fill whole
 * and the stroke in runs.
 * @param {DocObject} part resolved
 * @returns {SvgNode}
 */
function drawPart(part) {
  const fill = part.fill === undefined ? DEFAULTS.fill : part.fill;
  const stroke = part.stroke === undefined ? DEFAULTS.stroke : part.stroke;
  /** @type {Record<string, string | number>} */
  const fillAttrs = { fill: fill === null ? 'none' : String(fill) };
  if (part.closed !== false && Array.isArray(part.holes) && part.holes.length) fillAttrs['fill-rule'] = 'evenodd';
  if (fill !== null && part.fillOpacity !== undefined && part.fillOpacity !== 1) fillAttrs['fill-opacity'] = Number(part.fillOpacity);
  /** @type {Record<string, string | number>} */
  const strokeAttrs = {};
  if (stroke !== null) {
    strokeAttrs.stroke = String(stroke);
    if (part.strokeOpacity !== undefined && part.strokeOpacity !== 1) strokeAttrs['stroke-opacity'] = Number(part.strokeOpacity);
    strokeAttrs['stroke-width'] = Number(part.strokeWidth ?? DEFAULTS.strokeWidth);
    strokeAttrs['stroke-linejoin'] = String(part.strokeJoin ?? DEFAULTS.strokeJoin);
    strokeAttrs['stroke-linecap'] = String(part.strokeCap ?? DEFAULTS.strokeCap);
  }
  const id = part.id;
  if (stroke === null || !hidesEdges(part)) return { tag: 'path', attrs: { 'data-id': id, d: partData(part), ...fillAttrs, ...strokeAttrs }, children: [] };
  // The stroke path carries the id too, so it is picked by its stroke as a line is.
  return {
    tag: 'g',
    attrs: { 'data-id': id },
    children: [
      ...(fill === null ? [] : [{ tag: 'path', attrs: { d: partData(part), ...fillAttrs }, children: [] }]),
      { tag: 'path', attrs: { 'data-id': id, d: strokeData(part), fill: 'none', ...strokeAttrs }, children: [] },
    ],
  };
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
    nodes.push(drawPart(object));
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
