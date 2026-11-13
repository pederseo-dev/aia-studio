// Importar SVG: convierte las formas de un archivo SVG en paths editables dentro de un grupo nuevo.
// El SVG se monta oculto en la página (sin scripts ni eventos) para que el navegador resuelva transformaciones y
// estilos; de ahí se toman la geometría y los colores. Lo que no es geometría (texto, imágenes, filtros) se ignora.

import { parsearD, transformarVertices } from '../core/paths.js';

const FORMAS = 'path, rect, circle, ellipse, line, polyline, polygon';
const PELIGROSOS = 'script, foreignObject, iframe, object, embed, image, use, a';

/** Devuelve las operaciones para crear el grupo importado, o lanza si el archivo no sirve. */
export function operacionesDeImportar(texto, { doc, padre, nombre }) {
  const svg = new DOMParser().parseFromString(texto, 'image/svg+xml').documentElement;
  if (svg.nodeName !== 'svg' || svg.querySelector('parsererror')) throw new Error('The file is not a valid SVG');
  limpiar(svg);

  const contenedor = document.createElement('div');
  // Fuera de pantalla y transparente; sin visibility:hidden, que heredarían las formas y se descartarían.
  contenedor.style.cssText = 'position:fixed;left:-10000px;top:0;opacity:0;pointer-events:none';
  contenedor.append(document.importNode(svg, true));
  document.body.append(contenedor);
  try {
    return convertir(contenedor.querySelector('svg'), { doc, padre, nombre });
  } finally {
    contenedor.remove();
  }
}

function limpiar(svg) {
  svg.querySelectorAll(PELIGROSOS).forEach((el) => el.remove());
  for (const el of [svg, ...svg.querySelectorAll('*')]) {
    for (const { name, value } of [...el.attributes]) {
      if (/^on/i.test(name) || /javascript:/i.test(value) || name === 'href' || name === 'xlink:href') el.removeAttribute(name);
    }
  }
}

function convertir(raiz, { doc, padre, nombre }) {
  const usados = new Set(doc.objects.map((o) => o.id));
  const idLibre = (base) => {
    const limpio = base.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^[^a-z]+/, '').slice(0, 30) || 'forma';
    let id = limpio;
    for (let n = 2; usados.has(id); n++) id = `${limpio}_${n}`;
    usados.add(id);
    return id;
  };

  const grupo = idLibre(nombre || 'importado');
  const ops = [{ op: 'create', type: 'group', id: grupo, parent: padre }];
  const raizInversa = raiz.getScreenCTM().inverse();

  for (const el of raiz.querySelectorAll(FORMAS)) {
    if (el.closest('defs, clipPath, mask, symbol, marker, pattern')) continue;
    const estilo = getComputedStyle(el);
    if (estilo.display === 'none' || estilo.visibility === 'hidden') continue;
    const d = trazadoDe(el);
    if (!d) continue;
    // Matriz del elemento en las coordenadas del SVG raíz (incluye viewBox y todos los transform).
    const m = raizInversa.multiply(el.getScreenCTM());
    const matriz = [m.a, m.b, m.c, m.d, m.e, m.f];
    const escala = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));

    let subtrazados;
    try {
      subtrazados = parsearD(d);
    } catch {
      continue;
    }
    for (const s of subtrazados) {
      const vertices = transformarVertices(s.vertices, matriz);
      if (vertices.length < 2) continue;
      // Pivote en el centro de las anclas, y vértices relativos a él.
      const xs = vertices.map((v) => v.x);
      const ys = vertices.map((v) => v.y);
      const cx = Math.round(((Math.min(...xs) + Math.max(...xs)) / 2) * 10) / 10;
      const cy = Math.round(((Math.min(...ys) + Math.max(...ys)) / 2) * 10) / 10;
      const props = { x: cx, y: cy, vertices: transformarVertices(vertices, [1, 0, 0, 1, -cx, -cy]), closed: s.closed, ...pintura(estilo, escala) };
      ops.push({ op: 'create', type: 'path', id: idLibre(el.id || el.getAttribute('inkscape:label') || el.nodeName), parent: grupo, props });
    }
  }
  if (ops.length === 1) throw new Error('The SVG has no shapes that can be imported');
  return { ops, grupo };
}

/** Geometría de cualquier forma SVG como un `d`. */
function trazadoDe(el) {
  const a = (nombre) => parseFloat(el.getAttribute(nombre)) || 0;
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
      const numeros = (el.getAttribute('points') ?? '').trim().split(/[\s,]+/).map(Number);
      if (numeros.length < 4) return null;
      return `M${numeros.join(' ')}${el.nodeName === 'polygon' ? 'Z' : ''}`;
    }
  }
  return null;
}

function aHex(color) {
  const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/.exec(color);
  if (!m) return null;
  return { hex: '#' + m.slice(1, 4).map((v) => Number(v).toString(16).padStart(2, '0')).join(''), alfa: m[4] === undefined ? 1 : Number(m[4]) };
}

function pintura(estilo, escala) {
  const props = {};
  const relleno = estilo.fill === 'none' ? null : aHex(estilo.fill);
  props.fill = relleno ? relleno.hex : null;
  const contorno = estilo.stroke === 'none' ? null : aHex(estilo.stroke);
  if (contorno) {
    props.stroke = contorno.hex;
    props.strokeWidth = Math.round(parseFloat(estilo.strokeWidth || '1') * escala * 100) / 100;
  }
  const opacidad = parseFloat(estilo.opacity) * parseFloat(estilo.fillOpacity) * (relleno?.alfa ?? 1);
  if (opacidad < 1) props.opacity = Math.round(opacidad * 100) / 100;
  return props;
}
