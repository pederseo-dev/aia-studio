# Audit: Design mode, steps 1 to 12 (2026-11-17)

Two read-only reviews of the whole rebuild (f621923..7d544bd): a general audit and an editor ↔ AI parity check.
`npm test` and `npm run typecheck` passed before and after.

## Found and fixed

| # | What | Fix |
| --- | --- | --- |
| 1 | The store's settling quietly «fixed» references that never existed: a typo in `ref`, a group member or `follow` was saved as a point at (0, 0), dropped or lost, and the AI was told «Applied». | Only what the batch itself took away is mended (a point that was there before and is gone now); anything else is refused with the reason. |
| 2 | A shared vertex whose point a batch deleted landed at (0, 0) when the batch also set its part. | It keeps where its point was before the batch (or where the editor put it). |
| 3 | Undo per origin could take away the other side's work (undoing a layer deleted the person's drawing inside it), undos skipped the point rules, and a failed undo blocked that side's undo for good. | An undo that would delete or overwrite what the other side did after that step is refused, saying what; `aia undo --skip` (in the editor, undoing again) drops that step and goes on. Undos and redos go through the same rules as every batch. |
| 4 | A transformed layer without an origin jumped when its content changed (the Inspector's Rotation field, or a plain `set`), and changing the origin in the Inspector moved the layer. | The store gives every transformed layer an origin where it turns, and moving the origin of a transformed layer makes up with its x, y (`src/core/settle.js`), for every side alike. |
| 5 | Malformed batches (`[null]`, vertices that are not a list) came back as JavaScript errors. | They reach the engine, which says what is wrong. |
| 6 | The guide said coordinates were the artboard's; commands did not say which coordinates they take. | The guide and `aia help move` / `add-point` say: the layer's own coordinates, as the vertices. |
| 7 | A test said «broken points are refused» but only tested the engine, not the store the AI and the editor use. | Store tests for each case above (`tests/store.test.js`). |
| 8 | The README described only the base. | Updated. |

## Parity gaps (the AI cannot do what the editor does)

Rectangle and Ellipse, deleting points, corner ↔ curve, copies, transforming several parts around one point, and
seeing where named points are on the artboard. Built in step 13 (see docs/rebuild.md): `aia rect`, `ellipse`,
`delete-point`, `curve`, `corner`, `copy`, `transform` with several parts, and `render --labels`.
