// Trazados: vértices con tangentes en polares (ángulo + distancia, como Rive), su conversión a un `d` de SVG y
// desde un `d` de SVG. Un vértice:
//
//   { x, y }                                                        recto
//   { x, y, radius }                                                recto con la esquina redondeada
//   { x, y, mode: 'mirrored',   angle, dist }                       curva simétrica
//   { x, y, mode: 'asymmetric', angle, inDist, outDist }            misma dirección, largos distintos
//   { x, y, mode: 'detached',   inAngle, inDist, outAngle, outDist } tangentes independientes (pico)
//
// `angle` / `outAngle` es la dirección de la tangente de salida (hacia el vértice siguiente), en grados con Y hacia
// abajo (0 = derecha, 90 = abajo). La de entrada apunta hacia el vértice anterior: en mirrored y asymmetric es
// angle + 180; en detached, inAngle.

export const MODOS = ['straight', 'mirrored', 'asymmetric', 'detached'];
export const CAMPOS_DE_VERTICE = {
  straight: ['x', 'y', 'mode', 'radius'],
  mirrored: ['x', 'y', 'mode', 'angle', 'dist'],
  asymmetric: ['x', 'y', 'mode', 'angle', 'inDist', 'outDist'],
  detached: ['x', 'y', 'mode', 'inAngle', 'inDist', 'outAngle', 'outDist'],
};

const RAD = Math.PI / 180;
const KAPPA = 0.5523; // control de una cubic que aproxima un cuarto de círculo
const r2 = (v) => Math.round(v * 100) / 100 || 0;
const n = (v) => +v.toFixed(3);
const polar = (angulo, dist) => [Math.cos(angulo * RAD) * dist, Math.sin(angulo * RAD) * dist];
const largo = ([x, y]) => Math.hypot(x, y);
const anguloDe = ([x, y]) => r2(Math.atan2(y, x) / RAD);
const normalizarAngulo = (a) => ((((a + 180) % 360) + 360) % 360) - 180;

/** Tangentes de un vértice como vectores relativos al ancla. */
export function tangentes(v) {
  switch (v.mode ?? 'straight') {
    case 'mirrored': {
      const salida = polar(v.angle, v.dist);
      return { entrada: [-salida[0], -salida[1]], salida };
    }
    case 'asymmetric':
      return { entrada: polar(v.angle + 180, v.inDist), salida: polar(v.angle, v.outDist) };
    case 'detached':
      return { entrada: polar(v.inAngle, v.inDist), salida: polar(v.outAngle, v.outDist) };
    default:
      return { entrada: [0, 0], salida: [0, 0] };
  }
}

/** Construye un vértice a partir del ancla y sus tangentes, eligiendo el modo más simple que lo describe. */
export function verticeDesdeTangentes(x, y, entrada, salida, extra = {}) {
  const li = largo(entrada);
  const lo = largo(salida);
  const base = { x: r2(x), y: r2(y) };
  if (li < 0.01 && lo < 0.01) return { ...base, ...extra };
  if (li >= 0.01 && lo >= 0.01) {
    const ao = Math.atan2(salida[1], salida[0]) / RAD;
    const ai = Math.atan2(entrada[1], entrada[0]) / RAD;
    if (Math.abs(normalizarAngulo(ai - (ao + 180))) < 0.5) {
      if (Math.abs(li - lo) <= 0.01 * Math.max(li, lo)) return { ...base, mode: 'mirrored', angle: anguloDe(salida), dist: r2((li + lo) / 2) };
      return { ...base, mode: 'asymmetric', angle: anguloDe(salida), inDist: r2(li), outDist: r2(lo) };
    }
  }
  return {
    ...base,
    mode: 'detached',
    inAngle: li < 0.01 ? normalizarAngulo(anguloDe(salida) + 180) : anguloDe(entrada),
    inDist: r2(li),
    outAngle: lo < 0.01 ? normalizarAngulo(anguloDe(entrada) + 180) : anguloDe(salida),
    outDist: r2(lo),
  };
}

// ---------- Vértices → d ----------

/** Puntos con tangentes absolutas, con las esquinas redondeadas ya expandidas en dos puntos. */
function expandir(vertices, closed) {
  const puntos = [];
  vertices.forEach((v, i) => {
    const { entrada, salida } = tangentes(v);
    const radio = (v.mode ?? 'straight') === 'straight' ? (v.radius ?? 0) : 0;
    const anterior = vertices[i - 1] ?? (closed ? vertices.at(-1) : null);
    const siguiente = vertices[i + 1] ?? (closed ? vertices[0] : null);
    if (radio > 0 && anterior && siguiente && vertices.length > 2) {
      const a = [anterior.x - v.x, anterior.y - v.y];
      const b = [siguiente.x - v.x, siguiente.y - v.y];
      const r = Math.min(radio, largo(a) / 2, largo(b) / 2);
      if (r > 0) {
        const ua = [a[0] / largo(a), a[1] / largo(a)];
        const ub = [b[0] / largo(b), b[1] / largo(b)];
        const inicio = [v.x + ua[0] * r, v.y + ua[1] * r];
        const fin = [v.x + ub[0] * r, v.y + ub[1] * r];
        puntos.push({ p: inicio, entrada: [0, 0], salida: [-ua[0] * r * KAPPA, -ua[1] * r * KAPPA] });
        puntos.push({ p: fin, entrada: [-ub[0] * r * KAPPA, -ub[1] * r * KAPPA], salida: [0, 0] });
        return;
      }
    }
    puntos.push({ p: [v.x, v.y], entrada, salida });
  });
  return puntos;
}

export function verticesAD(vertices, closed) {
  if (!vertices?.length) return '';
  const puntos = expandir(vertices, closed);
  const tramo = (a, b) => {
    if (largo(a.salida) < 1e-9 && largo(b.entrada) < 1e-9) return `L${n(b.p[0])} ${n(b.p[1])}`;
    return `C${n(a.p[0] + a.salida[0])} ${n(a.p[1] + a.salida[1])} ${n(b.p[0] + b.entrada[0])} ${n(b.p[1] + b.entrada[1])} ${n(b.p[0])} ${n(b.p[1])}`;
  };
  let d = `M${n(puntos[0].p[0])} ${n(puntos[0].p[1])}`;
  for (let i = 1; i < puntos.length; i++) d += tramo(puntos[i - 1], puntos[i]);
  if (closed && puntos.length > 1) d += tramo(puntos.at(-1), puntos[0]) + 'Z';
  return d;
}

// ---------- d → vértices ----------

/**
 * Convierte un `d` de SVG en subtrazados [{ closed, vertices }]. Acepta todos los comandos (M L H V C S Q T A Z),
 * absolutos y relativos. Las cuadráticas y los arcos se convierten a cúbicas.
 */
export function parsearD(d) {
  const texto = String(d);
  let i = 0;
  const saltar = () => {
    while (i < texto.length && /[\s,]/.test(texto[i])) i++;
  };
  const numero = () => {
    saltar();
    const m = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(texto.slice(i));
    if (!m) throw new Error(`d inválido: se esperaba un número en la posición ${i}`);
    i += m[0].length;
    return Number(m[0]);
  };
  const bandera = () => {
    saltar();
    const c = texto[i++];
    if (c !== '0' && c !== '1') throw new Error(`d inválido: bandera de arco "${c}" en la posición ${i - 1}`);
    return c === '1';
  };
  const subtrazados = [];
  let actual = null;
  let pos = [0, 0];
  let inicio = [0, 0];
  let ultimoControl = null;
  let ultimoComando = '';

  const empezar = (p) => {
    actual = { closed: false, puntos: [{ p, entrada: [0, 0], salida: [0, 0] }] };
    subtrazados.push(actual);
    inicio = p;
  };
  const asegurar = () => actual ?? empezar(pos);
  const cubica = (c1, c2, p) => {
    asegurar();
    const ultimo = actual.puntos.at(-1);
    ultimo.salida = [c1[0] - ultimo.p[0], c1[1] - ultimo.p[1]];
    actual.puntos.push({ p, entrada: [c2[0] - p[0], c2[1] - p[1]], salida: [0, 0] });
    pos = p;
  };
  const linea = (p) => {
    asegurar();
    actual.puntos.push({ p, entrada: [0, 0], salida: [0, 0] });
    pos = p;
  };

  while (true) {
    saltar();
    if (i >= texto.length) break;
    let comando = texto[i];
    if (/[a-zA-Z]/.test(comando)) i++;
    else if (ultimoComando && ultimoComando.toUpperCase() !== 'Z') comando = ultimoComando === 'M' ? 'L' : ultimoComando === 'm' ? 'l' : ultimoComando;
    else throw new Error(`d inválido: comando esperado en la posición ${i}`);
    const rel = comando === comando.toLowerCase();
    const C = comando.toUpperCase();
    const abs = (x, y) => (rel ? [pos[0] + x, pos[1] + y] : [x, y]);
    let control = null;

    switch (C) {
      case 'M': {
        const p = abs(numero(), numero());
        pos = p;
        empezar(p);
        break;
      }
      case 'L':
        linea(abs(numero(), numero()));
        break;
      case 'H': {
        const x = numero();
        linea([rel ? pos[0] + x : x, pos[1]]);
        break;
      }
      case 'V': {
        const y = numero();
        linea([pos[0], rel ? pos[1] + y : y]);
        break;
      }
      case 'C': {
        const c1 = abs(numero(), numero());
        const c2 = abs(numero(), numero());
        const p = abs(numero(), numero());
        cubica(c1, c2, p);
        control = c2;
        break;
      }
      case 'S': {
        const c1 = ultimoControl && 'CS'.includes(ultimoComando.toUpperCase()) ? [2 * pos[0] - ultimoControl[0], 2 * pos[1] - ultimoControl[1]] : pos;
        const c2 = abs(numero(), numero());
        const p = abs(numero(), numero());
        cubica(c1, c2, p);
        control = c2;
        break;
      }
      case 'Q':
      case 'T': {
        const q = C === 'Q' ? abs(numero(), numero()) : ultimoControl && 'QT'.includes(ultimoComando.toUpperCase()) ? [2 * pos[0] - ultimoControl[0], 2 * pos[1] - ultimoControl[1]] : pos;
        const p = abs(numero(), numero());
        const p0 = pos;
        cubica([p0[0] + (2 / 3) * (q[0] - p0[0]), p0[1] + (2 / 3) * (q[1] - p0[1])], [p[0] + (2 / 3) * (q[0] - p[0]), p[1] + (2 / 3) * (q[1] - p[1])], p);
        control = q;
        break;
      }
      case 'A': {
        const rx = numero();
        const ry = numero();
        const rot = numero();
        const grande = bandera();
        const horario = bandera();
        const p = abs(numero(), numero());
        for (const [c1, c2, fin] of arcoACubicas(pos, rx, ry, rot, grande, horario, p)) cubica(c1, c2, fin);
        pos = p;
        break;
      }
      case 'Z': {
        if (actual) {
          const primero = actual.puntos[0];
          const ultimo = actual.puntos.at(-1);
          if (actual.puntos.length > 1 && Math.hypot(ultimo.p[0] - primero.p[0], ultimo.p[1] - primero.p[1]) < 1e-6) {
            primero.entrada = ultimo.entrada;
            actual.puntos.pop();
          }
          actual.closed = true;
          actual = null;
        }
        pos = inicio;
        break;
      }
      default:
        throw new Error(`d inválido: comando desconocido "${comando}"`);
    }
    ultimoControl = control;
    // Si siguen números sin letra, se repite este comando (M repetido es L).
    ultimoComando = comando;
  }

  return subtrazados
    .filter((s) => s.puntos.length > 1 || s.closed)
    .map((s) => ({ closed: s.closed, vertices: s.puntos.map((pt) => verticeDesdeTangentes(pt.p[0], pt.p[1], pt.entrada, pt.salida)) }));
}

/** Arco elíptico de SVG → lista de cúbicas [c1, c2, fin] (algoritmo de la especificación SVG, apéndice F.6). */
function arcoACubicas(p0, rx, ry, rotacion, grande, horario, p) {
  if (Math.hypot(p[0] - p0[0], p[1] - p0[1]) < 1e-9) return [];
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (!rx || !ry) return [[p0, p, p]];
  const fi = rotacion * RAD;
  const cos = Math.cos(fi);
  const sin = Math.sin(fi);
  const dx = (p0[0] - p[0]) / 2;
  const dy = (p0[1] - p[1]) / 2;
  const x1 = cos * dx + sin * dy;
  const y1 = -sin * dx + cos * dy;
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const signo = grande === horario ? -1 : 1;
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const coef = signo * Math.sqrt(Math.max(0, num / (rx * rx * y1 * y1 + ry * ry * x1 * x1)));
  const cx1 = (coef * rx * y1) / ry;
  const cy1 = (-coef * ry * x1) / rx;
  const cx = cos * cx1 - sin * cy1 + (p0[0] + p[0]) / 2;
  const cy = sin * cx1 + cos * cy1 + (p0[1] + p[1]) / 2;
  const angulo = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = angulo(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let dt = angulo((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!horario && dt > 0) dt -= 2 * Math.PI;
  if (horario && dt < 0) dt += 2 * Math.PI;

  const partes = Math.ceil(Math.abs(dt) / (Math.PI / 2));
  const paso = dt / partes;
  const k = (4 / 3) * Math.tan(paso / 4);
  const punto = (t) => [cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos];
  const derivada = (t) => [-rx * Math.sin(t) * cos - ry * Math.cos(t) * sin, -rx * Math.sin(t) * sin + ry * Math.cos(t) * cos];
  const cubicas = [];
  for (let j = 0; j < partes; j++) {
    const a = t1 + j * paso;
    const b = a + paso;
    const pa = punto(a);
    const pb = j === partes - 1 ? p : punto(b);
    const da = derivada(a);
    const db = derivada(b);
    cubicas.push([[pa[0] + k * da[0], pa[1] + k * da[1]], [pb[0] - k * db[0], pb[1] - k * db[1]], pb]);
  }
  return cubicas;
}

// ---------- Transformar y editar ----------

/** Aplica una matriz afín [a b c d e f] a los vértices (anclas y tangentes). */
export function transformarVertices(vertices, m) {
  const escala = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
  return vertices.map((v) => {
    const { entrada, salida } = tangentes(v);
    const lineal = ([x, y]) => [m[0] * x + m[2] * y, m[1] * x + m[3] * y];
    const extra = v.radius ? { radius: r2(v.radius * escala) } : {};
    return verticeDesdeTangentes(m[0] * v.x + m[2] * v.y + m[4], m[1] * v.x + m[3] * v.y + m[5], lineal(entrada), lineal(salida), extra);
  });
}

/** Anclas y extremos de las tangentes en coordenadas absolutas (para dibujar las manijas del editor). */
export function manijas(vertices) {
  return vertices.map((v) => {
    const { entrada, salida } = tangentes(v);
    return {
      ancla: [v.x, v.y],
      entrada: largo(entrada) > 0.01 ? [v.x + entrada[0], v.y + entrada[1]] : null,
      salida: largo(salida) > 0.01 ? [v.x + salida[0], v.y + salida[1]] : null,
    };
  });
}

function tramoCubico(vertices, i) {
  const a = vertices[i];
  const b = vertices[(i + 1) % vertices.length];
  const ta = tangentes(a).salida;
  const tb = tangentes(b).entrada;
  return [[a.x, a.y], [a.x + ta[0], a.y + ta[1]], [b.x + tb[0], b.y + tb[1]], [b.x, b.y]];
}

const lerp = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];

/** Puntos a lo largo del tramo i (del vértice i al siguiente), para buscar dónde hizo clic el usuario. */
export function muestrearTramo(vertices, i, pasos = 24) {
  const [p0, p1, p2, p3] = tramoCubico(vertices, i);
  return Array.from({ length: pasos + 1 }, (_, k) => {
    const t = k / pasos;
    const a = lerp(lerp(p0, p1, t), lerp(p1, p2, t), t);
    const b = lerp(lerp(p1, p2, t), lerp(p2, p3, t), t);
    return { t, p: lerp(a, b, t) };
  });
}

/** Inserta un vértice en el tramo i, en el parámetro t, sin cambiar la forma (de Casteljau). */
export function dividirTramo(vertices, i, t) {
  const [p0, p1, p2, p3] = tramoCubico(vertices, i);
  // Tramo recto: el vértice nuevo también es recto.
  if (p1[0] === p0[0] && p1[1] === p0[1] && p2[0] === p3[0] && p2[1] === p3[1]) {
    const p = lerp(p0, p3, t);
    return [...vertices.slice(0, i + 1), { x: r2(p[0]), y: r2(p[1]) }, ...vertices.slice(i + 1)];
  }
  const a = lerp(p0, p1, t);
  const b = lerp(p1, p2, t);
  const c = lerp(p2, p3, t);
  const ab = lerp(a, b, t);
  const bc = lerp(b, c, t);
  const medio = lerp(ab, bc, t);
  const j = (i + 1) % vertices.length;
  const resultado = [...vertices];
  const conTangente = (v, cual, punto) => {
    const t2 = tangentes(v);
    t2[cual] = [punto[0] - v.x, punto[1] - v.y];
    return verticeDesdeTangentes(v.x, v.y, t2.entrada, t2.salida);
  };
  resultado[i] = conTangente(vertices[i], 'salida', a);
  resultado[j] = conTangente(vertices[j], 'entrada', c);
  const nuevo = verticeDesdeTangentes(medio[0], medio[1], [ab[0] - medio[0], ab[1] - medio[1]], [bc[0] - medio[0], bc[1] - medio[1]]);
  resultado.splice(i + 1, 0, nuevo);
  return resultado;
}

/** Errores de un vértice (lista vacía si está bien). */
export function erroresDeVertice(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return ['debe ser un objeto { x, y, ... }'];
  const modo = v.mode ?? 'straight';
  if (!MODOS.includes(modo)) return [`mode debe ser ${MODOS.join(', ')}`];
  const errores = [];
  const campos = CAMPOS_DE_VERTICE[modo];
  for (const k of Object.keys(v)) if (!campos.includes(k)) errores.push(`campo "${k}" no va en un vértice ${modo} (campos: ${campos.join(', ')})`);
  for (const k of campos) {
    if (k === 'mode' || (k === 'radius' && v.radius === undefined)) continue;
    if (typeof v[k] !== 'number' || !Number.isFinite(v[k])) errores.push(`falta ${k} (número)`);
    else if (/Dist$|^dist$|^radius$/.test(k) && v[k] < 0) errores.push(`${k} no puede ser negativo`);
  }
  return errores;
}
