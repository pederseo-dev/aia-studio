// Shared core types, for checking with `npm run typecheck` (tsc over JS with JSDoc). They generate no code.

/** Affine matrix [a, b, c, d, e, f], the same one SVG uses in matrix(...). */
export type Matrix = number[];
/** Point [x, y]. */
export type Point = [number, number];

/** An object of the document: `type`, `id`, `parent` and its properties (defined by the schema). */
export interface Object {
  id: string;
  type: string;
  parent?: string | null;
  [prop: string]: any;
}

/** The document: `format`, `meta` and the flat list of objects. */
export interface Document {
  format: number;
  meta: Record<string, any>;
  objects: Object[];
  [prop: string]: any;
}

/** An operation of a batch: create, set, unset, delete, move, rename, duplicate (and the internal `_...` ones). */
export interface Operation {
  op: string;
  target?: string;
  [field: string]: any;
}

/** Options for what is drawn (render/svg.js and the MCP previews). */
export interface ViewOptions {
  /** Pose seen on top of the setup (a pose object or its already resolved values). */
  pose?: any;
  params?: Record<string, number>;
  animation?: any;
  time?: number;
  times?: number[];
  poses?: any[];
  show?: any;
  /** src of an image layer → href it is drawn with (the editor: the server URL). */
  assets?: (src: string) => string;
  region?: { x: number; y: number; width: number; height: number };
  bones?: boolean;
  columns?: number;
}
