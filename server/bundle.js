// The runtime as one classic script, for pages that load it without a bundler or a server (aia export --format
// html works from a double click, file:// included). It follows the ES module imports from src/runtime/player.js
// and wraps each module in a function of its own, in dependency order, so their names never clash.
// It only understands the plain forms the runtime's modules use: `import { a, b as c } from './x.js'` and
// `export function | async function | const | let | class name`; anything else is an error, not a silent mistake.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENTRY = fileURLToPath(new URL('../src/runtime/player.js', import.meta.url));
const IMPORT = /^import\s*\{([^}]*)\}\s*from\s*'([^']+)';?[ \t]*$/gm;
const EXPORT = /^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm;

/**
 * The runtime as a script that sets `globalThis.aiaRuntime = { createPlayer }`.
 * @returns {string}
 */
export function bundleRuntime() {
  /** @type {Map<string, string>} file → its wrapped code, in the order they must run */
  const done = new Map();
  /** @type {Set<string>} */
  const visiting = new Set();
  /** @param {string} file */
  const name = (file) => path.relative(path.dirname(ENTRY), file).replace(/\\/g, '/');

  /** @param {string} file */
  function visit(file) {
    if (done.has(file)) return;
    if (visiting.has(file)) throw new Error(`The runtime's modules import each other in a circle (${name(file)})`);
    visiting.add(file);
    let code = fs.readFileSync(file, 'utf8');
    /** @type {string[]} */
    const lines = [];
    code = code.replace(IMPORT, (_, names, from) => {
      if (!from.startsWith('.')) throw new Error(`${name(file)} imports "${from}": the runtime takes no packages`);
      const dep = path.resolve(path.dirname(file), from);
      visit(dep);
      const bindings = names
        .split(',')
        .map((/** @type {string} */ n) => n.trim())
        .filter(Boolean)
        .map((/** @type {string} */ n) => n.replace(/\s+as\s+/, ': '));
      lines.push(`const { ${bindings.join(', ')} } = modules[${JSON.stringify(name(dep))}];`);
      return '';
    });
    if (/^\s*(import|export)\b(?!\s+(?:async\s+)?(?:function|const|let|class)\b)/m.test(code)) {
      throw new Error(`${name(file)} has an import or export the runtime bundle does not understand`);
    }
    const exported = [...code.matchAll(EXPORT)].map((m) => m[1]);
    code = code.replace(/^export\s+/gm, '');
    done.set(
      file,
      `modules[${JSON.stringify(name(file))}] = (() => {\n${lines.join('\n')}\n${code}\nreturn { ${exported.join(', ')} };\n})();`,
    );
    visiting.delete(file);
  }

  visit(ENTRY);
  return `// aia-studio runtime (built from src/runtime/player.js)\n(() => {\n'use strict';\nconst modules = {};\n${[...done.values()].join('\n')}\nglobalThis.aiaRuntime = { createPlayer: modules[${JSON.stringify(name(ENTRY))}].createPlayer };\n})();\n`;
}
