// Importar SVG: convierte las formas de un archivo SVG en paths editables dentro de un grupo nuevo.
// El SVG se monta oculto en la página (sin scripts ni eventos) para que el navegador resuelva transformaciones y
// estilos; de ahí se toman la geometría y los colores. Lo que no es geometría (texto, imágenes, filtros) se ignora.

import { parseD, transformVertices } from '../core/paths.js';

const SHAPES = 'path, rect, circle, ellipse, line, polyline, polygon';
const DANGEROUS = 'script, foreignObject, iframe, object, embed, image, use, a';

/** Devuelve las operaciones para crear el grupo importado, o lanza si el archivo no sirve. */
export function importOperations(text, { doc, parent, name }) {
  const svg = new DOMParser().parseFromString(text, 'image/svg+xml').documentElement;
  if (svg.nodeName !== 'svg' || svg.querySelector('parsererror')) throw new Error('The file is not a valid SVG');
  clean(svg);

  const container = document.createElement('div');
  // Fuera de pantalla y transparente; sin visibility:hidden, que heredarían las formas y se descartarían.
  container.style.cssText = 'position:fixed;left:-10000px;top:0;opacity:0;pointer-events:none';
  container.append(document.importNode(svg, true));
  document.body.append(container);
  try {
    return convert(container.querySelector('svg'), { doc, parent, name });
  } finally {
    container.remove();
  }
}

function clean(svg) {
  svg.querySelectorAll(DANGEROUS).forEach((el) => el.remove());
  for (const el of [svg, ...svg.querySelectorAll('*')]) {
    for (const { name, value } of [...el.attributes]) {
      if (/^on/i.test(name) || /javascript:/i.test(value) || name === 'href' || name === 'xlink:href') el.removeAttribute(name);
    }
  }
}

function convert(root, { doc, parent, name }) {
  const used = new Set(doc.objects.map((o) => o.id));
  const freeId = (base) => {
    const clean = base.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^[^a-z]+/, '').slice(0, 30) || 'shape';
    let id = clean;
    for (let n = 2; used.has(id); n++) id = `${clean}_${n}`;
    used.add(id);
    return id;
  };

  const group = freeId(name || 'importado');
  const ops = [{ op: 'create', type: 'group', id: group, parent: parent }];
  const rootInverse = root.getScreenCTM().inverse();

  for (const el of root.querySelectorAll(SHAPES)) {
    if (el.closest('defs, clipPath, mask, symbol, marker, pattern')) continue;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const d = pathOf(el);
    if (!d) continue;
    // Matriz del elemento en las coordenadas del SVG raíz (incluye viewBox y todos los transform).
    const m = rootInverse.multiply(el.getScreenCTM());
    const matrix = [m.a, m.b, m.c, m.d, m.e, m.f];
    const scale = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));

    let subpaths;
    try {
      subpaths = parseD(d);
    } catch {
      continue;
    }
    for (const s of subpaths) {
      const vertices = transformVertices(s.vertices, matrix);
      if (vertices.length < 2) continue;
      // Pivote en el centro de las anclas, y vértices relativos a él.
      const xs = vertices.map((v) => v.x);
      const ys = vertices.map((v) => v.y);
      const cx = Math.round(((Math.min(...xs) + Math.max(...xs)) / 2) * 10) / 10;
      const cy = Math.round(((Math.min(...ys) + Math.max(...ys)) / 2) * 10) / 10;
      const props = { x: cx, y: cy, vertices: transformVertices(vertices, [1, 0, 0, 1, -cx, -cy]), closed: s.closed, ...paint(style, scale) };
      ops.push({ op: 'create', type: 'path', id: freeId(el.id || el.getAttribute('inkscape:label') || el.nodeName), parent: group, props });
    }
  }
  if (ops.length === 1) throw new Error('The SVG has no shapes that can be imported');
  return { ops, group };
}

/** Geometría de cualquier forma SVG como un `d`. */
function pathOf(el) {
  const a = (name) => parseFloat(el.getAttribute(name)) || 0;
  switch (el.nodeName) {
    case 'path':
      return el.getAttribute('d');
    case 'rect': {
      const [x, y, w, h] = [a('x'), a('y'), a('width'), a('height')];
      if (!w || !h) return null;
      let rx = Math.min(a('rx') || a('ry'), w / 2);
      let ry = Math.min(a('ry') || a('rx'), h / 2);
      if (!rx) return `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
      return `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`;
    }
    case 'circle':
    case 'ellipse': {
      const [cx, cy] = [a('cx'), a('cy')];
      const rx = el.nodeName === 'circle' ? a('r') : a('rx');
      const ry = el.nodeName === 'circle' ? a('r') : a('ry');
      if (!rx || !ry) return null;
      return `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`;
    }
    case 'line':
      return `M${a('x1')} ${a('y1')}L${a('x2')} ${a('y2')}`;
    case 'polyline':
    case 'polygon': {
      const numbers = (el.getAttribute('points') ?? '').trim().split(/[\s,]+/).map(Number);
      if (numbers.length < 4) return null;
      return `M${numbers.join(' ')}${el.nodeName === 'polygon' ? 'Z' : ''}`;
    }
  }
  return null;
}

function toHex(color) {
  const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/.exec(color);
  if (!m) return null;
  return { hex: '#' + m.slice(1, 4).map((v) => Number(v).toString(16).padStart(2, '0')).join(''), alpha: m[4] === undefined ? 1 : Number(m[4]) };
}

function paint(style, scale) {
  const props = {};
  const fill = style.fill === 'none' ? null : toHex(style.fill);
  props.fill = fill ? fill.hex : null;
  const outline = style.stroke === 'none' ? null : toHex(style.stroke);
  if (outline) {
    props.stroke = outline.hex;
    props.strokeWidth = Math.round(parseFloat(style.strokeWidth || '1') * scale * 100) / 100;
  }
  const opacity = parseFloat(style.opacity) * parseFloat(style.fillOpacity) * (fill?.alpha ?? 1);
  if (opacity < 1) props.opacity = Math.round(opacity * 100) / 100;
  return props;
}
