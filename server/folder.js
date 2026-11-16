// Where the documents live. Everything that reads or writes documents (the editor server today; the CLI and the MCP
// later) resolves the folder here, so they always agree. In order:
// 1. the `--documents <folder>` argument,
// 2. the AIA_DOCUMENTS environment variable (the installed desktop app sets it to its user data folder),
// 3. the repo's documents/ folder (running from source).

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_DOCUMENTS = fileURLToPath(new URL('../documents/', import.meta.url));

/**
 * @param {{ argv?: string[], env?: Record<string, string | undefined> }} [from]
 * @returns {string} an absolute path
 */
export function resolveDocumentsFolder({ argv = process.argv, env = process.env } = {}) {
  const i = argv.indexOf('--documents');
  const chosen = (i >= 0 && argv[i + 1]) || env.AIA_DOCUMENTS;
  return path.resolve(chosen || REPO_DOCUMENTS);
}
