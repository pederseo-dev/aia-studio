// Proyección de un personaje a SVG como texto. La usan el runtime (montaje inicial) y el MCP (vista previa).

export const matrizSvg = (m) => `matrix(${m.map((n) => +n.toFixed(4)).join(' ')})`;
export const opacidad = (o) => Math.min(1, Math.max(0, o));

/** Partes y slots en orden de dibujo (z ascendente; a igual z, el orden del documento). */
export function dibujables(doc) {
  return [
    ...doc.rig.parts.map((p) => ({ tipo: 'part', ...p })),
    ...doc.rig.slots.map((s) => ({ tipo: 'slot', ...s })),
  ].sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
}

export function svgComoTexto(doc, pose, mundo) {
  const { width, height } = doc.canvas;
  const cuerpo = dibujables(doc).map((d) => {
    const transform = matrizSvg(mundo[d.bone]);
    if (d.tipo === 'part') {
      return `<g data-part="${d.id}" transform="${transform}" opacity="${opacidad(pose.parts[d.id].opacity)}">${d.svg}</g>`;
    }
    const opciones = Object.entries(d.options)
      .map(([nombre, svg]) => `<g data-option="${nombre}"${nombre === pose.slots[d.id].active ? '' : ' display="none"'}>${svg}</g>`)
      .join('');
    return `<g data-slot="${d.id}" transform="${transform}">${opciones}</g>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">\n${cuerpo.join('\n')}\n</svg>`;
}
