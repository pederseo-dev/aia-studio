// The schema in the editor: the same schema/*.json files the server reads, bundled by Vite.

import { resolveSchema } from '../core/schema.js';

const files = import.meta.glob('/schema/*.json', { eager: true, import: 'default' });

export const schema = resolveSchema(/** @type {import('../core/schema.js').TypeDefinition[]} */ (Object.values(files)));

/** Whether an object of type `child` can go inside one of type `parent`. @param {string} parent @param {string} child */
export const canContain = (parent, child) => !!schema.get(parent)?.childTypes.includes(child);

/** Parts are the drawing inside a vector layer; everything else in Layers is a layer. @param {string} type */
export const isPart = (type) => canContain('vector', type);
