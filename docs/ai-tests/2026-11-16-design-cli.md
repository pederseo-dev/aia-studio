# AI test: Design mode with the `aia` CLI, first cut (2026-11-16)

**Setup.** An AI agent with only `node bin/aia.js …` (no repo files, no source) and the images `render` writes.
It learned the tool from `aia help` and `aia guide`.

**Task.** A new document `prueba_ai_face` with a cartoon face: a curved head; two ears welded to the head with shared
points; two eyes; a mouth as an open line whose ends share named points of another part; a point group of the
mouth area. It had to render and fix what looked wrong, undo one of its own steps, then move a shared point of the
head and check that the ear followed.

**Result: done, about 23 commands, 1 refused.** The head is a 12-vertex circle with 8 named points. The ears share
`head.ear_*_top` / `head.ear_*_bot`, and the mouth's ends share `cheeks.corner_l` / `corner_r`. The group
`mouth_area` holds five points. It used undo on purpose, and moving `head.ear_l_top` dragged the ear along, which the
render confirmed. The history shows 5 steps, all `ai`.

## What went wrong or was hard

| What | Why |
| --- | --- |
| `set` on `"head.ear_l_top"` was refused ("there is no object") | There is no way to move one point: the whole `vertices` array must be sent again. This is verbose, and it is easy to break the other points. The error is clear but does not say how. |
| A circle with more than 4 vertices | `guide paths` only gives the 4-vertex circle; 12 vertices (needed to have weld points) meant doing the handle math by hand. |
| Undo took back a good fix along with the mistake | A batch is one step: the guide did not say «one concern per batch». |
| `show` prints a shared vertex as `{ ref }` only | It cannot see where the vertex sits without looking up the point. |
| `help render` did not say where the PNG goes | It always passed `--out`. |

The rules about refs were understood from the guide alone. No batch broke a shared point, and a forward reference
inside one batch (ears before the head) worked.

## Higher-level commands it asked for (most useful first)

1. Move points by name, or a whole point group, absolute or relative (`set_point head.ear_l_top {x,y}` / `move_points`).
2. Shape makers with named points: an ellipse with N segments and names.
3. Edit one vertex (insert, change its handles) without resending the array.
4. `show --resolved` (refs with their x, y), and a check that lists welds and groups.
5. `weld` by name or by proximity.

## Fixed right away

- `help render` says where the PNG goes, and `guide ops` says a batch is one undo step («one concern per batch»).
- `guide points` says how a point is moved today (send the part's vertices).

The higher-level commands are open: they are for the user to choose (topic 3).
