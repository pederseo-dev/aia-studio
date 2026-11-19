// The `aia` commands of one topic. Documents: list, make, delete, look at, change with operations, undo, redo,
// history, add an image.

import fs from 'node:fs/promises';
import path from 'node:path';
import { findObject, subtree } from '../../src/core/document.js';
import { addImageOps, replaceImageOps } from '../../src/core/images.js';
import { resolveDoc } from '../../src/core/points.js';
import { AiaError, changes, compactJson, ok } from './common.js';

/**
 * @typedef {import('./common.js').Command} Command
 * @typedef {import('./common.js').Context} Context
 * @typedef {import('../../src/core/operations.js').Operation} Operation
 */

/** @param {Context} ctx @returns {Record<string, Command>} */
export function documentsCommands(ctx) {
  const { store, ORIGIN, need, number, resolved, pair } = ctx;
  return {
    list: {
      usage: 'aia list',
      summary: 'The documents: id and name',
      run: async () => {
        const docs = await store.list();
        if (!docs.length) return ok('No documents yet. Make one: aia new "<name>"');
        const width = Math.max(...docs.map((d) => d.id.length));
        return ok(docs.map((d) => `${d.id.padEnd(width)}  ${d.name}`).join('\n'));
      },
    },

    new: {
      usage: 'aia new <name> [--width 800] [--height 600] [--background #ffffff|none]',
      summary: 'A new document; its id comes from the name',
      details: 'The artboard is 800 × 600 px with a white background unless told otherwise. Prints the new id.',
      run: async (args) => {
        const name = need(args, 0, 'the name of the new document');
        /** @type {Record<string, unknown>} */
        const meta = { name };
        const width = number(args, 'width');
        const height = number(args, 'height');
        if (width) meta.width = width;
        if (height) meta.height = height;
        const background = args.flags.background;
        if (background !== undefined) meta.background = background === 'none' ? null : background;
        const { id } = await store.create(meta);
        return ok(`Created ${id}. Next: aia ops ${id} '<batch>' (aia guide ops)`);
      },
    },

    delete: {
      usage: 'aia delete <doc> --yes',
      summary: 'Deletes a document and its history, for good',
      details: 'It cannot be undone, so --yes is required. Only delete documents you made or were asked to delete.',
      run: async (args) => {
        const id = need(args, 0, 'the document id');
        if (args.flags.yes !== true) throw new AiaError(`Deleting ${id} cannot be undone: add --yes if that is what is wanted`);
        await store.remove(id);
        return ok(`Deleted ${id}.`);
      },
    },

    show: {
      usage: 'aia show <doc> [id] [--resolved]',
      summary: 'The document as it is saved (JSON), or one object with what is inside it',
      details: '--resolved gives each shared vertex the x, y of the point it shares (as it is drawn), to check welds.',
      run: async (args) => {
        const id = need(args, 0, 'the document id');
        const saved = (await store.get(id, ORIGIN)).document;
        const document = args.flags.resolved === true ? resolveDoc(saved) : saved;
        const target = args.positional[1];
        if (!target) return ok(compactJson(document));
        if (target === 'meta') return ok(compactJson(document.meta));
        if (!findObject(document, target)) throw new AiaError(`${id} has no object "${target}"`);
        return ok(compactJson(subtree(document, target)));
      },
    },

    ops: {
      usage: "aia ops <doc> [--note \"…\"] '<batch>' | --file <batch.json>",
      summary: 'Applies a batch of operations (one step you can undo)',
      details:
        'The batch is a JSON list of operations (a single operation works too); see aia guide ops. It is atomic:\n' +
        'if one operation fails nothing changes, and the error says which one and why. --note says what the step\n' +
        'is for; it shows in the history.',
      run: async (args) => {
        const id = need(args, 0, 'the document id');
        const file = args.flags.file;
        const source = typeof file === 'string' ? await fs.readFile(file, 'utf8') : args.positional[1];
        if (!source) throw new AiaError('Missing the batch: a JSON list of operations (aia guide ops)');
        /** @type {unknown} */
        let batch;
        try {
          batch = JSON.parse(source);
        } catch (e) {
          throw new AiaError(`The batch is not valid JSON: ${e.message}`);
        }
        /** @type {Operation[]} */
        const ops = /** @type {Operation[]} */ (Array.isArray(batch) ? batch : [batch]);
        const note = typeof args.flags.note === 'string' ? args.flags.note : undefined;
        const before = (await store.get(id, ORIGIN)).document;
        const { document } = await store.apply(id, ops, { origin: ORIGIN, note });
        return ok(`Applied ${ops.length} operation${ops.length > 1 ? 's' : ''} to ${id}. ${changes(before, document)}`);
      },
    },

    undo: {
      usage: 'aia undo <doc> [--skip]',
      summary: 'Undoes your last step (never the person’s)',
      details:
        'It is refused, with the reason, when it would take away or overwrite what the person did after that step.\n' +
        '--skip then drops that step from your undo (nothing changes), so you can undo older ones.',
      run: async (args) => {
        const id = need(args, 0, 'the document id');
        const skip = args.flags.skip === true;
        const { canUndo } = await store.undo(id, ORIGIN, { skip });
        const done = skip ? `Skipped your last step on ${id} (it stays as it is).` : `Undid your last step on ${id}.`;
        return ok(`${done}${canUndo ? '' : ' Nothing more of yours to undo.'}`);
      },
    },

    redo: {
      usage: 'aia redo <doc>',
      summary: 'Redoes the step you undid last',
      run: async (args) => {
        const id = need(args, 0, 'the document id');
        await store.redo(id, ORIGIN);
        return ok(`Redid your step on ${id}.`);
      },
    },

    history: {
      usage: 'aia history <doc> [--all]',
      summary: 'The steps, newest last; the person’s ("user") are theirs to keep',
      details: 'Shows the last 20 steps unless --all. Each line: number, who (ai or user), what (batch, undo, redo), the note.',
      run: async (args) => {
        const id = need(args, 0, 'the document id');
        await store.get(id, ORIGIN);
        const entries = await store.history(id);
        if (!entries.length) return ok(`${id} has no steps yet.`);
        const shown = args.flags.all ? entries : entries.slice(-20);
        const lines = shown.map((e) => {
          const what = e.kind === 'batch' ? `${e.ops.length} op${e.ops.length > 1 ? 's' : ''}` : `${e.kind} of #${e.of}`;
          return `#${e.n} ${e.origin.padEnd(4)} ${what}${e.note ? ` — ${e.note}` : ''}`;
        });
        const skipped = entries.length - shown.length;
        return ok(`${skipped ? `(${skipped} older steps: --all)\n` : ''}${lines.join('\n')}`);
      },
    },

    image: {
      usage: 'aia image <doc> <file> [--id name] [--in group] [--at x,y] [--width N | --height N] [--opacity 0.5] | --replace <layer>',
      summary: 'Adds an image layer from a picture file (PNG, JPEG, WebP or SVG), for example a reference to draw over',
      details:
        'The file is copied into the document’s assets folder; <file> is a path on this computer (relative to where\n' +
        'aia runs, or absolute). The layer goes on top of the root (--in: of a group), as big as the picture made\n' +
        'smaller to fit the artboard, centered (--at: on that point of the artboard). The picture is drawn from (0, 0)\n' +
        'in the layer’s coordinates: x, y place it, and aia transform moves, turns and scales it as any layer.\n' +
        'A reference to trace: --opacity 0.5, then lock it (set locked: true) so it is not picked by mistake.\n' +
        '--replace changes the picture of an image layer (keeps its width, takes the new proportion).\n' +
        'Example: aia image robot C:/refs/robot_front.png --id ref --opacity 0.4',
      run: async (args) => {
        const id = need(args, 0, 'the document id');
        const file = need(args, 1, 'the picture file');
        let bytes;
        try {
          bytes = new Uint8Array(await fs.readFile(path.resolve(file)));
        } catch {
          throw new AiaError(`Can't read the file "${file}"`);
        }
        const { src, naturalWidth, naturalHeight, reused } = await store.saveAsset(id, path.basename(file), bytes);
        const { document } = await store.get(id, ORIGIN);
        const replace = args.flags.replace;
        const opacity = args.flags.opacity === undefined ? undefined : Number(args.flags.opacity);
        if (opacity !== undefined && !(opacity >= 0 && opacity <= 1)) throw new AiaError('--opacity is a number from 0 to 1');
        /** @type {{ id: string, ops: Operation[] }} */
        let plan;
        try {
          if (typeof replace === 'string') plan = { id: replace, ops: replaceImageOps(document, replace, { src, naturalWidth, naturalHeight }) };
          else {
            const parent = typeof args.flags.in === 'string' ? args.flags.in : null;
            if (parent !== null && findObject(document, parent)?.type !== 'group') throw new AiaError(`${id} has no group "${parent}"`);
            plan = addImageOps(document, {
              src,
              naturalWidth,
              naturalHeight,
              id: typeof args.flags.id === 'string' ? args.flags.id : undefined,
              parent,
              at: pair(args, 'at'),
              width: number(args, 'width'),
              height: number(args, 'height'),
            });
          }
        } catch (e) {
          throw new AiaError(e.message);
        }
        if (opacity !== undefined) plan.ops.push({ op: 'set', target: plan.id, props: { opacity } });
        const note = typeof replace === 'string' ? `${plan.id}: picture ${src}` : `Image layer ${plan.id}`;
        await store.apply(id, plan.ops, { origin: ORIGIN, note });
        const layer = findObject((await store.get(id, ORIGIN)).document, plan.id);
        const size = `${naturalWidth} × ${naturalHeight} px${reused ? ', already in assets' : ''}`;
        return ok(
          `${typeof replace === 'string' ? 'Changed the picture of' : 'Added the image layer'} ${plan.id}: ${src} (${size}), ` +
            `drawn ${layer?.width} × ${layer?.height} at ${layer?.x ?? 0}, ${layer?.y ?? 0}.`,
        );
      },
    },
  };
}
