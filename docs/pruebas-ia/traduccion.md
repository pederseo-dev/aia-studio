# Translation check: the whole pipeline with the English guide and MCP

What is measured: whether moving the AI-facing texts from Spanish to English (the guide in `src/core/guide.js`, the
schema `description`s, every MCP tool description, parameter, response and error) made the AI worse. It is not a new
feature test: it repeats, in a condensed form, the tasks of phases 1 to 6 and compares with those runs.

Setup: the `aia-studio` MCP server started fresh in a new session on branch `fase-4/params` (after the rename
commits up to 9cc3c2b), so it served the current code. `documents/` was empty (the copies `kiko_vivo`,
`gato_expresiones`, etc. used by phases 4–6 were not there), so the run builds a new character from scratch in
`prueba_robot` and goes through every phase on it. The "by hand in the editor" touch-ups were simulated with
`store.applyOps(..., { origin: 'user' })`, the same path the editor API uses, as in phase 5.

## Tasks

1. Create "Robot", 600×600, light blue background. Draw a simple robot with rectangles and ellipses (body, head,
   eyes, mouth, antenna, two arms) in groups so the head and each arm move separately. Show it. *(phase 1)*
2. Put the arms behind the body. *(phase 1)*
3. Make the palette shared styles (metal, dark metal, accent) with a gradient on the metal; make the antenna a curved
   open path; change the metal color all at once. *(phase 2)*
4. Build a skeleton: body bone, head bone from the neck, one bone per arm; bind the drawing; limit the head to ±30°;
   a pose with the left arm waving and the head tilted. *(phase 3)*
5. Expressions: `happiness` from -1 (sad) to 1 (happy) changing mouth, eyes and antenna; `head_turn` from -1 to 1;
   `viseme` with rest, a, e, o, m. Show happy looking right, and sad looking left saying "o". *(phase 4)*
6. Puppet clips: a blink, an idle loop, a happy wave of a bit over a second; the head comes back with a small
   bounce; a 4 s Animate scene (rest, blink, wave, rest). *(phase 5)*
7. Live assistant: blink and breathe on their own; base states idle, listening, thinking and talking; a laugh that
   returns to idle; show it as the app would (idle → listening → thinking → talking + wave); softer wave that leaves
   the mouth free; read the manifest; undo the last change. *(phase 6)*
8. *(Simulated touch-up, origin `user`: wave arm higher at 0.6 s, orange antenna in `happy`, wider left eye.)*
   Make the eyes a bit bigger, lengthen the wave half a second at the end, and make `happy` also lift the arms,
   without touching what I changed. Then undo the last change. *(phases 1, 3, 5)*

## Results

| Date | Client and model | Done | Rejections | Manual fixes | Notes |
| --- | --- | --- | --- | --- | --- |
| 2026-11-12/13 | Claude Code (side session, MCP only) with Opus 5.5 | 8/8 | 1 from the validator (my `"-=-140"`) | None | See below |

**How it went:** the robot came out in one batch of 20 ops with pivots at the neck and shoulders; arms moved behind
with `move` + `index`. Styles: a `linear_gradient` in `fillGradient` of the `metal` style, the shapes cleared their
own `fill` with `unset`; the color change was one `set` of the gradient's `stops`. Rig: `skeleton` + `move` of the
drawing + bones with `from`/`to` + `bone` on the groups, `minAngle`/`maxAngle` relative to the parent (0 ± 30), and a
`set_pose` checked with `show_bones`. Expressions in one batch of 28 ops: a mouth `switch` whose `mouth_rest` is a
2-vertex path that morphs for happy/sad, two drivers per number param (0…1 and 0…-1) and one driver with `equals` per
viseme; both blends checked with `render_preview` + `params` + `region`. Clips with `set_keys` and `setup: true` at
the ends, `"+=n"` relative angles and `params` in the Puppet clips; the bounce with a moment that only carries
`ease: "ease-out-back"` and `targets`. Phase 6: `blink` to `auto: "repeat"` with `fade` 0, a new `breathe`
(`always`, `additive`), three bases with descriptions (talking animates `viseme`), `laugh` with `next: "idle"`, the
live script read frame by frame, `fade` 0.4 and `remove: ["viseme"]` on the wave, manifest with nothing missing. With
the touch-ups: read `get_history` with `origin: "user"` and `detail`, kept the user's `eye_l.width`, lengthened the
wave with `duration` only, added the arms to `happy` without `replace` (the orange antenna stayed), and `undo` undid
only that pose change.

**Compared with the Spanish runs:** same level. Phases 1–6 ended with 7/7 to 9/9 tasks and 0–1 rejections; this run
did all eight condensed tasks with one rejection, which was my own typo and not a misreading. No term in the English
guide was ambiguous: Setup, Pose, Switch, Base/gesture, `auto`, `fade` and `next` read the same as the Rive/Moho
words the editor uses. The warnings and summaries in English were as clear as before (for example the warning that a
rotation was more than 180° from the setup, which caught a wrong angle in `idle`).

**What it found:**

1. **Leftover Spanish:** the `meta.name` default was still `"Sin nombre"` (shown in the guide's `meta` table).
2. **Unclear rejection:** `"-=-140"` failed with `value must be a number (received "-=-140")`, which doesn't say
   that the relative form is `"+=n"`/`"-=n"` with a positive `n`.
3. **Bug (runtime, not the translation):** in a `loop` clip, a frame exactly at a keyframe time can show the
   previous keyframe. `localTime` computes `((t % d) + d) % d`, and `((0.2 % 1.2) + 1.2) % 1.2` is 0.19999…: in
   `talking`, t = 0.2 s showed "rest" instead of "a" (0.201 s was fine). Discrete values (an enum, a switch's
   `active`) are the visible case; numbers are off by a negligible amount.
4. **History summary too coarse for clips and poses:** a user touch-up of one keyframe or one pose value shows in
   `get_history` as the whole `wave.tracks` / `happy.values`; to know what they changed I had to diff the `detail`
   ops by hand (the undo conflict check already works per track and per object).
5. Small: `apply_ops` returns the whole tree even for a 2-op batch (about 70 lines here); the `set_keys` strip
   after lengthening a clip with `duration` shows only the keyframe times and doesn't show the new held end.
6. My own slip worth a line in the guide some day: in the scene, a pose copied with `pose` at 1.8 s faded in from
   t = 0 because the rest at 1.4 s only keyed some tracks; `setup: true` at 1.4 s fixed it.

**Fixed:**

1. `"Untitled"` as the `meta.name` default (commit 891aeaf).
2. `set_keys` rejects a malformed relative value with `"-=-140" is not a relative value: write "+=n" or "-=n" with a
   positive number n (for example "+=140" or "-=140")`, with a test (commit 70de2bb).

**Pending:** the loop-time rounding bug (3), a per-track / per-object history summary (4), and the smaller points in 5.
