// Renders public/logo.svg to build/icon.png (512 px), the icon electron-builder turns into the app and installer icons.

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';

const svg = readFileSync(new URL('../public/logo.svg', import.meta.url), 'utf8');
const png = new Resvg(svg, { fitTo: { mode: 'width', value: 512 }, background: 'rgba(0,0,0,0)' }).render().asPng();
mkdirSync(new URL('../build/', import.meta.url), { recursive: true });
writeFileSync(new URL('../build/icon.png', import.meta.url), png);
console.log(`build/icon.png: ${png.length} bytes`);
