// Tipos compartidos del núcleo, para la verificación con `npm run tipos` (tsc sobre JS con JSDoc). No generan código.

/** Matriz afín [a, b, c, d, e, f], la misma que usa SVG en matrix(...). */
export type Matriz = number[];
/** Punto [x, y]. */
export type Punto = [number, number];

/** Un objeto del documento: `type`, `id`, `parent` y sus propiedades (las define el esquema). */
export interface Objeto {
  id: string;
  type: string;
  parent?: string | null;
  [prop: string]: any;
}

/** El documento: `format`, `meta` y la lista plana de objetos. */
export interface Documento {
  format: number;
  meta: Record<string, any>;
  objects: Objeto[];
  [prop: string]: any;
}

/** Una operación de un lote: create, set, unset, delete, move, rename, duplicate (y las internas `_...`). */
export interface Operacion {
  op: string;
  target?: string;
  [campo: string]: any;
}

/** Opciones de lo que se dibuja (render/svg.js y las vistas previas del MCP). */
export interface OpcionesDeVista {
  /** Pose que se ve encima del montaje (un objeto pose o sus valores ya resueltos). */
  pose?: any;
  params?: Record<string, number>;
  animation?: any;
  time?: number;
  times?: number[];
  poses?: any[];
  mostrar?: any;
  /** src de una capa image → href con que se dibuja (el editor: la URL del servidor). */
  assets?: (src: string) => string;
  region?: { x: number; y: number; width: number; height: number };
  huesos?: boolean;
  columnas?: number;
}
