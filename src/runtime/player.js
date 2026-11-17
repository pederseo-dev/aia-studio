// The runtime: plays an aia-studio document outside the editor, in any web page, with no dependencies (decision 5:
// the runtime is the contract every part must play in). For now it draws the document as it is (shared points,
// followed stretches, layer transforms); later it will play clips and take parameters.
//
//   import { createPlayer } from './player.js';
//   const player = createPlayer(document.querySelector('svg'), doc);  // doc: the document's JSON
//   player.update(changedDoc);
//
// It draws with the same drawDocument as the editor and the AI's previews (src/core/draw.js), so what is made in the
// editor is what plays.

import { drawDocument } from '../core/draw.js';

/**
 * @typedef {import('../core/document.js').Doc} Doc
 * @typedef {import('../core/draw.js').SvgNode} SvgNode
 */

const NS = 'http://www.w3.org/2000/svg';

/**
 * A player on an <svg> element: it sizes it to the artboard and draws the document inside.
 * @param {SVGSVGElement} svg
 * @param {Doc} doc
 */
export function createPlayer(svg, doc) {
  const page = svg.ownerDocument;
  /** @param {SvgNode} node @returns {Element} */
  const build = (node) => {
    const el = page.createElementNS(NS, node.tag);
    for (const [name, value] of Object.entries(node.attrs)) el.setAttribute(name, String(value));
    for (const child of node.children) el.append(build(child));
    return el;
  };
  /** @type {Doc} */
  let current = doc;

  function draw() {
    const { width, height, background, nodes } = drawDocument(current);
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    if (!svg.hasAttribute('width') && !svg.hasAttribute('height')) {
      svg.setAttribute('width', String(width));
      svg.setAttribute('height', String(height));
    }
    /** @type {Element[]} */
    const children = [];
    if (background) children.push(build({ tag: 'rect', attrs: { width, height, fill: background }, children: [] }));
    children.push(...nodes.map(build));
    svg.replaceChildren(...children);
  }

  draw();
  return {
    /** The document it plays. */
    get document() {
      return current;
    },
    /** Plays another version of the document (for example after a change). @param {Doc} next */
    update(next) {
      current = next;
      draw();
    },
  };
}
