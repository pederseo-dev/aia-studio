// Where the documents live. The editor server and the MCP must agree on it, so both resolve it here:
// 1. the `--documents <folder>` argument (the MCP, when an AI client launches it with one),
// 2. the AIA_DOCUMENTS environment variable (the desktop app sets it for its server and in the AI client entry),
// 3. the repo's documents/ folder (development).

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_DOCUMENTS = fileURLToPath(new URL('../documents/', import.meta.url));

/** @param {{ argv?: string[], env?: Record<string, string | undefined> }} [from] */
export function resolveDocumentsFolder({ argv = process.argv, env = process.env } = {}) {
  const i = argv.indexOf('--documents');
  const chosen = (i >= 0 && argv[i + 1]) || env.AIA_DOCUMENTS;
  return chosen ? path.resolve(chosen) : REPO_DOCUMENTS;
}

/** Folder for aia-studio's own files next to the documents (MCP status markers); hidden from the documents list. */
export const stateFolder = (documents) => path.join(documents, '.aia');
