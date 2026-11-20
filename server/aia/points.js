// The `aia` commands of one topic. Points: move, delete, curve or corner, weld and unweld, name, add on a line,
// follow a curve, hide an edge, group.

import { findObject } from '../../src/core/document.js';
import { insertVertex, nearestOnOutline, verticesOf } from '../../src/core/geometry.js';
import { movePointsOps, pointsNamed } from '../../src/core/points.js';
import { deletePointsOps, followOps, groupOps, namePoint, unweld, weld } from '../../src/core/weld.js';
import { edgeOps, stretchBetweenPoints } from '../../src/core/edges.js';
import { AiaError, ok } from './common.js';

/**
 * @typedef {import('./common.js').Command} Command
 * @typedef {import('./common.js').Context} Context
 * @typedef {import('../../src/core/operations.js').Operation} Operation
 */

/** @param {Context} ctx @returns {Record<string, Command>} */
export function pointsCommands(ctx) {
  const { store, ORIGIN, need, resolved, points, onePoint, welding, shapeCommand, pair } = ctx;
  return {
    move: {
      usage: 'aia move <doc> <point>... --by dx,dy | --to x,y',
      summary: 'Moves points by name: named points, vertices by index, or point groups',
      details:
        'A point is part.point (head.chin), part.index (head.3, from 0) or layer.group (face.upper_lid: all its\n' +
        'points). --by moves them all by an offset; --to places one point. Their curve handles go along, and the\n' +
        'vertices that share them follow (a shared vertex named here moves the point it shares). One step to undo.\n' +
        'Places and offsets are in the coordinates of the layer the points belong to (as their vertices).\n' +
        'Example: aia move face head.ear_l_top head.ear_l_bot --by -10,0',
      run: async (args) => {
        const id = need(args, 0, 'the document id');
        const names = args.positional.slice(1);
        if (!names.length) throw new AiaError('Missing the points to move: part.point, part.index or layer.group');
        const by = pair(args, 'by');
        const to = pair(args, 'to');
        if (!by === !to) throw new AiaError('Say where: --by dx,dy (an offset) or --to x,y (one point)');
        const { document } = await store.get(id, ORIGIN);
        let ops;
        try {
          ops = movePointsOps(document, pointsNamed(document, names), { by, to });
        } catch (e) {
          throw new AiaError(e.message);
        }
        const note = typeof args.flags.note === 'string' ? args.flags.note : `Move ${names.join(', ')}`;
        await store.apply(id, ops, { origin: ORIGIN, note });
        const where = by ? `by ${by.x}, ${by.y}` : `to ${to?.x}, ${to?.y}`;
        return ok(`Moved ${names.join(', ')} ${where}. Changed: ${ops.map((o) => o.target).join(', ')}.`);
      },
    },

    'delete-point': {
      usage: 'aia delete-point <doc> <point>...',
      summary: 'Deletes points of outlines, as Del in point editing (a part left with fewer than 2 points is deleted)',
      details:
        'Whoever shared a deleted point keeps its place, as a point of its own; groups drop it. A part left with fewer\n' +
        'than 2 points (an outline needs 2) is deleted with them, in the same step.',
      run: async (args) => {
        const id = need(args, 0, 'the document id');
        const doc = await resolved(id);
        const names = args.positional.slice(1);
        if (!names.length) throw new AiaError('Missing the points to delete');
        const { ops, gone } = deletePointsOps(doc, points(doc, names));
        await store.apply(id, ops, { origin: ORIGIN, note: `Delete ${names.join(', ')}` });
        const whole = gone.length ? ` ${gone.join(', ')} kept fewer than 2 points, so ${gone.length > 1 ? 'they were' : 'it was'} deleted.` : '';
        return ok(`Deleted ${names.join(', ')} (the points after them moved down one index).${whole}`);
      },
    },

    curve: {
      usage: 'aia curve <doc> <point>...',
      summary: 'Makes points smooth curves (handles along their neighbors), as Curve in point editing',
      run: async (args) => shapeCommand(args, false),
    },

    corner: {
      usage: 'aia corner <doc> <point>...',
      summary: 'Makes points corners (no handles), as Corner in point editing',
      run: async (args) => shapeCommand(args, true),
    },

    weld: {
      usage: 'aia weld <doc> <point> <target point> [--join] | aia weld <doc> <point> --on <part>',
      summary: 'Welds a point to a point of another part (it shares it from then on), or onto its line',
      details:
        'The first point goes to the target and shares it ({ "ref": "jaw.chin" }); the target gets a name if it has\n' +
        'none. --on <part> welds it onto that part’s line, where it is nearest, adding a point there. The two ends of\n' +
        'one line close it. --join: two open ends of two lines become one line (the first line is deleted).\n' +
        'Points: part.point or part.index. Example: aia weld face mouth.0 jaw.chin',
      run: async (args) => {
        const id = need(args, 0, 'the document id');
        const doc = await resolved(id);
        const moving = onePoint(doc, need(args, 1, 'the point to weld'));
        const on = args.flags.on;
        /** @type {import('../../src/core/weld.js').WeldTarget} */
        let target;
        if (typeof on === 'string') {
          const part = findObject(doc, on);
          if (!part || part.type !== 'path') throw new AiaError(`there is no part "${on}"`);
          const from = verticesOf(/** @type {any} */ (findObject(doc, moving.part)))[moving.index];
          const hit = nearestOnOutline(part, from);
          if (!hit) throw new AiaError(`${on} has no line to weld onto`);
          target = { part: on, segment: hit.segment, t: hit.t };
        } else target = onePoint(doc, need(args, 2, 'the target point (or --on <part>)'));
        const w = welding(() => weld(doc, moving, target, { merge: args.flags.join === true }));
        await store.apply(id, w.ops, { origin: ORIGIN, note: w.note });
        return ok(`${w.note}.`);
      },
    },

    unweld: {
      usage: 'aia unweld <doc> <point>...',
      summary: 'The points stop sharing: each keeps its place as a point of its own',
      details: 'A shared vertex stops sharing; a point that others share is unwelded from all of them.',
      run: async (args) => {
        const id = need(args, 0, 'the document id');
        const doc = await resolved(id);
        const names = args.positional.slice(1);
        if (!names.length) throw new AiaError('Missing the points to unweld');
        const ops = welding(() => unweld(doc, points(doc, names)));
        await store.apply(id, ops, { origin: ORIGIN, note: `Unweld ${names.join(', ')}` });
        return ok(`Unwelded ${names.join(', ')}.`);
      },
    },

    name: {
      usage: 'aia name <doc> <point> <name> | --none',
      summary: 'Names a point (part.index or its old name), so it can be shared, grouped and moved by name',
      details: 'Shared points and groups follow a new name. --none takes the name away, if nothing uses it.',
      run: async (args) => {
        const id = need(args, 0, 'the document id');
        const doc = await resolved(id);
        const at = onePoint(doc, need(args, 1, 'the point'));
        const typed = args.flags.none === true ? '' : need(args, 2, 'the new name (or --none)');
        const { ops, name } = welding(() => namePoint(doc, at, typed));
        if (!ops.length) return ok('It already has that name.');
        await store.apply(id, ops, { origin: ORIGIN, note: name ? `Name ${at.part}.${name}` : `Unname a point of ${at.part}` });
        return ok(name ? `Named ${at.part}.${name}.` : `${at.part} vertex ${at.index} has no name now.`);
      },
    },

    'add-point': {
      usage: 'aia add-point <doc> <part> --at x,y [--name <name>]',
      summary: 'Adds a point on a part’s line where it is nearest to x,y, without changing its shape',
      details: 'x,y is in the coordinates of the part’s layer (as its vertices).',
      run: async (args) => {
        const id = need(args, 0, 'the document id');
        const doc = await resolved(id);
        const partId = need(args, 1, 'the part');
        const part = findObject(doc, partId);
        if (!part || part.type !== 'path') throw new AiaError(`there is no part "${partId}"`);
        const at = pair(args, 'at');
        if (!at) throw new AiaError('Say where: --at x,y (the point goes on the line, where it is nearest)');
        const hit = nearestOnOutline(part, at);
        if (!hit) throw new AiaError(`${partId} has no line to add a point on (or it only follows other parts)`);
        const { vertices, index } = insertVertex(part, hit.segment, hit.t);
        const name = typeof args.flags.name === 'string' ? args.flags.name : undefined;
        if (name) {
          if (vertices.some((v) => v.name === name)) throw new AiaError(`${partId} has a point named "${name}" already`);
          vertices[index] = { ...vertices[index], name };
        }
        await store.apply(id, [{ op: 'set', target: partId, props: { vertices } }], { origin: ORIGIN, note: `Add a point to ${partId}` });
        const p = vertices[index];
        return ok(`Added ${partId}.${name ?? index} at ${p.x}, ${p.y} (vertex ${index}; the ones after it moved up one).`);
      },
    },

    follow: {
      usage: 'aia follow <doc> <point> <point> [--long | --off]',
      summary: 'The stretch between two neighbor points follows the curve of another part that passes through both',
      details:
        'Both points are in one part, next to each other, and welded to another part: points it owns, or points it\n' +
        'shares too (where two lines meet). The stretch then goes along that part’s outline: the short way, or --long\n' +
        'the other. --off stops it. A part that follows others is not followed (a fill follows lines, not fills).',
      run: async (args) => {
        const id = need(args, 0, 'the document id');
        const doc = await resolved(id);
        const a = onePoint(doc, need(args, 1, 'the first point'));
        const b = onePoint(doc, need(args, 2, 'the second point'));
        const how = args.flags.off === true ? 'off' : args.flags.long === true ? 'long' : 'short';
        const { ops, note } = welding(() => followOps(doc, a, b, how));
        await store.apply(id, ops, { origin: ORIGIN, note });
        return ok(`${note}.`);
      },
    },

    edge: {
      usage: 'aia edge <doc> <part> <point> <point> --hide | --show',
      summary: 'Hides or shows the stroke of a part between two points next to each other (Moho’s Hide Edge)',
      details:
        'The fill is not changed. The two points are part.point or part.index, next to each other along the part’s\n' +
        'stroke: for an element, two of its own points; for a shape that follows a line (head_stroke), two points of\n' +
        'that line (head.2 head.3). Points without a name get one, since a hidden edge is the pair of their names\n' +
        '(hiddenEdges on the part). Example: aia edge face head_stroke head.2 head.3 --hide',
      run: async (args) => {
        const id = need(args, 0, 'the document id');
        const doc = await resolved(id);
        const partId = need(args, 1, 'the part whose stroke it is');
        const a = onePoint(doc, need(args, 2, 'the first point'));
        const b = onePoint(doc, need(args, 3, 'the second point'));
        const hide = args.flags.hide === true;
        if (hide === (args.flags.show === true)) throw new AiaError('Say one of --hide or --show');
        const { ops, edge, named } = welding(() => edgeOps(doc, stretchBetweenPoints(doc, partId, a, b), hide));
        await store.apply(id, ops, { origin: ORIGIN, note: `${hide ? 'Hide' : 'Show'} an edge of ${partId}` });
        const stroke = findObject(doc, partId)?.stroke;
        const none = hide || stroke !== null ? '' : ` (${partId} has no stroke, so nothing shows there yet)`;
        const names = named.length ? ` (named now: ${named.join(', ')})` : '';
        return ok(`${hide ? 'Hid' : 'Showed'} the stroke of ${partId} between ${edge[0]} and ${edge[1]}${names}${none}.`);
      },
    },

    group: {
      usage: 'aia group <doc> <layer>.<group> <point>... [--add | --remove | --delete]',
      summary: 'Point groups of a vector layer: set a group to these points, add or take them out, or delete it',
      details:
        'Without a flag the group becomes exactly these points (made if new). Points without a name get one\n' +
        '(part_1…). Example: aia group face face.upper_lid lid.0 lid.1 brow.mid',
      run: async (args) => {
        const id = need(args, 0, 'the document id');
        const doc = await resolved(id);
        const full = need(args, 1, 'the group, as layer.group');
        const match = /^([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)$/.exec(full);
        if (!match) throw new AiaError(`"${full}" is not a group: write it as layer.group (face.upper_lid)`);
        const flags = args.flags;
        const action = flags.delete === true ? 'delete' : flags.add === true ? 'add' : flags.remove === true ? 'remove' : 'set';
        const names = args.positional.slice(2);
        const { ops, name } = welding(() => groupOps(doc, match[1], action, match[2], action === 'delete' ? [] : points(doc, names)));
        await store.apply(id, ops, { origin: ORIGIN, note: `Group ${match[1]}.${match[2]}: ${action}` });
        return ok(action === 'delete' ? `Deleted the group ${match[1]}.${name}.` : `${match[1]}.${name}: ${action === 'set' ? 'set' : action === 'add' ? 'added to' : 'taken out of'}.`);
      },
    },
  };
}
