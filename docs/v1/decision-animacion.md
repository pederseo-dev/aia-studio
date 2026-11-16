# Decision: animation (phase 5), puppet (phases 5–6) and export (phase 7)

> Status: **agreed with the user** (2026-11-05). Replaces what [plan.md](plan.md) said about phases 5 to 7 and
> completes §6 of [sintesis.md](sintesis.md).

## 1. Three working modes

The editor is split into three modes, by **what** the work is **for**:

| | **Design** | **Animate** | **Puppet** |
|---|---|---|---|
| What for | Drawing and rigging (setup, frame 0) | Telling something from start to finish: traditional animation of characters, objects or environments | Getting the character ready for someone else to drive live: an app's AI, a game, code |
| Timeline | None | **One long timeline** (the scene) | **Many short timelines**: one per clip |
| Right panel | Inspector | Inspector | **Clip library as buttons** (triggers) + inspector |
| Exports to | — | Video, Lottie, SVG/CSS (baked) | `.aia` + runtime (live) |

- **Design no longer has poses.** Poses, params and drivers are the puppet's controls: they move to **Puppet**.
  Design is left for pure drawing and rig (what used to be «View: Setup»).
- **Puppet** has the controls: expressions (params → poses), clips (gestures, loops, reactions) and, in phase 6, the
  behavior (state machine). Each clip is a **button** in the right panel:
  - click → the timeline below switches to that clip (like «entering» an action in Moho; the frame changes color);
  - with **▶ Live** on, the button *triggers* the clip and params move with sliders: it looks as the app's AI
    will see it, with fades between clips.
- References: Rive (Design / Animate and the list of animations the state machine blends), Moho (actions that are
  edited separately and inserted by reference), Adobe Character Animator (*puppets* with a *triggers* panel).

## 2. A single animation engine

Animate and Puppet use **the same clip type, the same tracks and the same timeline**. The only thing that changes is the
use (`usage`): in Animate, one long timeline; in Puppet, many clips with their card for the AI. That way:

- **A Puppet clip can be inserted in Animate** (by reference, like Moho actions): «wave» is animated
  once and used in many scenes. Touching up the clip updates them all. *(The simple timeline comes first; insertion
  by reference comes later within phase 5.)*
- Video, Lottie and the runtime come out of the **same evaluator**: `(document, clip, t, params) → values`. Live, the
  runtime calls it every frame; for baking, it is sampled at the document's fps. Rule: **what the model
  expresses is what the runtime evaluates**; what a target does not support is baked when exporting to that target.

## 3. Data model

A new asset, `animation` (the clip):

```jsonc
{
  "id": "wave", "type": "animation",
  "usage": "puppet",            // "animate" (the scene's timeline) or "puppet" (the puppet's clip)
  "duration": 1.2,              // seconds
  "loop": "once",               // "once", "loop" or "pingpong" (from Rive)
  "description": "Waves with the right hand", // for the app's AI (manifest) and the button
  "tracks": {
    "arm_r_bone": { "rotation": [ { "t": 0, "value": 0 }, { "t": 0.3, "value": -60, "ease": "ease-out" } ] },
    "mouth":      { "active":   [ { "t": 0, "value": "mouth_open" } ] },
    "happiness":  { "value":    [ { "t": 0, "value": 0 }, { "t": 0.6, "value": 1 } ] }
  }
}
```

- **Tracks per object and property**, with the same shape as a pose's `values` (`{ id: { property: … } }`): the AI
  already knows it. Any animatable property works: bones, vertices (morph with the same number of points), colors,
  opacity, a switch's child.
- **A param is also a track** (`{ param_id: { value: […] } }`): a clip can take `happiness` from 0 to 1 and
  thus reuse the expressions (like animating the control of a Moho smart bone) instead of repeating keyframes.
- **Keyframe** = `{ t, value, ease }`. Time in seconds, between 0 and `duration`. Absolute values, as in the
  setup and the poses.
- **The curve goes in the keyframe** and applies to the segment that leaves it (Moho and Rive): `linear` (default), `step`
  (holds until the next one: Moho's *hold*), `ease-in`, `ease-out`, `ease-in-out` or `[x1, y1, x2, y2]`
  (`cubic-bezier` as in CSS). `cubic-bezier` was chosen because it carries over losslessly to CSS, Lottie and Rive. Elastic,
  bounce, noisy and Moho's «on twos» are left for later; when exporting to a target that lacks them, they are baked.
- What is not interpolated (a switch's `active`, booleans, texts) changes abruptly at each keyframe. Numbers
  are interpolated with the curve; colors, per channel; vertices, like the poses' morph (if the count does not
  match, they change abruptly).
- Before the first keyframe the first one applies; after the last, the last one (Rive). A property without a track takes
  the setup's value.

## 4. Evaluation order

```
setup → clip at t (absolute values) → params (the clip's override those from outside) → drivers add their poses on top
```

1. The clip sets the values of its tracks at time `t` (with `loop`: `once` stays at the end, `loop` starts
   over, `pingpong` goes back and forth).
2. Param tracks give the value of those params; the other params come from outside (the app, the sliders) or from their
   initial value.
3. Drivers add their poses **on top of what is animated**: an animated wave plus the happy face a param gives. For
   numbers, each pose's difference is still measured against the setup (as in the phase 4 blend) and added
   to what is animated; colors and vertices are interpolated from what is animated toward the pose.
4. **What is not added is decided by the clip's track** *(change of 2026-11-05, from the phase 5 audit)*: if the
   clip has a track on a color, some vertices, a switch's child or a boolean, the drivers do not change it. The
   drivers still decide where the clip has no track. Reason: an enum param always has an active option (and
   a numeric param can start other than 0), so its driver weighed 1 in every clip and hid the keyframe of
   `mouth.active`. When a param picks the variant (visemes), the natural thing is to animate the param, not `active`.
   Numbers are still added: `clipWarnings` (in `set_keys`, `render_preview` and the timeline) warns when an
   active driver adds its pose to a clip track, and the editor's autokey stores the value without that contribution.

5. **An Animate scene is evaluated without drivers** *(2026-11-06, follows «params are Puppet-only», §8)*:
   setup + keyframes, nothing else (Design + what is animated). Everything above about params and drivers applies to Puppet
   clips. Reason: with params Puppet-only, in a scene the drivers added with the params at their initial value,
   with no control or warning (a param with `default` 1 rotated a box that looks straight in Design). In a scene, an
   expression is copied as keyframes («◆ Pose…» or `set_keys` with `pose`) and a variant is chosen by keying the switch's
   `active`. The same holds in the editor, in `render_preview` (with a scene, it rejects `params`), in `clipWarnings`
   (a scene has no warnings) and in export, because they all use `clipPose`.

The result is one more pose, drawn with the same render as always (`src/render/svg.js`).

## 5. Export (phase 7)

| Target | What comes out | What is lost |
|---|---|---|
| **`.aia` + JS runtime** (priority) | The document without history or editor data, with a manifest for the app's AI: params with description and range, Puppet clips with their card and states. The runtime is `src/core` + `src/render`. | Nothing: everything stays live. It only runs where the runtime reaches (web, Electron). |
| **Video** (mp4/webm/gif, PNG per frame) | An Animate clip (or a Puppet one with fixed params) sampled at the document's fps, with resvg and ffmpeg. | Interaction. |
| **Lottie / SVG-CSS** | Simple tracks (transforms with `cubic-bezier` curves) carry over directly; bones, per-point binding and blended poses are baked frame by frame. | Params and state machine (dotLottie has state machines, but without our pose blending). |

## 6. The AI

- **Editing (MCP):** `set_keys` creates or updates a clip thinking in **moments**: «at t = 0.3, the arm like this and the
  mouth like this» (`values` as in `set_pose`), or «at t = 0.3, the `happy` pose» (copies its values as keyframes, as in
  Moho). `delete_keys` removes keyframes by time or by property. `render_preview` accepts `animation` + `time`, and
  `times` for a **strip of frames** in a single image, to see the motion without asking for ten images. The tree from
  `get_document` summarizes each clip (usage, duration, loop, what it animates and at which times).
- **After the second test (2026-11-06):** `scale_time` rescales the time of a clip or a range in a single
  undo step (the editor does it with «Scale keys» when changing Length); `pose` accepts `only`/`except` to copy
  a part; a number in `values` can be **relative to the setup** (`"+=14"`), which is resolved when saving: the track
  still stores absolute values, so the format does not change. The strong named curves (`-quad`, `-cubic`,
  `-expo`, `-back`) are fixed cubic-beziers, so they carry over losslessly to CSS, Lottie and Rive. `set_keys` and
  `render_preview` list which poses each animated param moves (a user's driver can move more than expected).
- **Live use (phase 7):** the manifest turns Puppet clips into tools for the app's LLM
  (`play("wave")`, `set_param("happiness", 0.8)`), with each clip's description.

## 7. Ideas noted for later

- **Record a performance (Puppet → Animate):** with Live on, ● Rec records the buttons and sliders as tracks
  in an Animate timeline (like Character Animator's *takes*). Useful to make a video without animating frame by
  frame, and for the AI to «act out» a script and leave something that can be touched up.
- **Clips by body region (masks):** a clip declares what it touches (arms, face, mouth) to add «wave» +
  «talk» + «happy» without them overriding each other (Rive state machine layers, Unity avatar masks). Goes with phase 6.
- **Additive clips** (breathing, swaying) that add on top of any other.
- **Keyboard shortcut per button** in Puppet.
- **Scenes with several characters** in Animate: each one, an instance of another document with its Puppet (Rive's
  *nested artboards*, Moho's referenced layers). Do not close the door on the design.
- **The procedural as character data:** which clip is the blink and which params are the gaze and the mouth, so the
  runtime turns them on with one line (the *when* still belongs to the app).
- `elastic`, `bounce`, `noisy` curves and animation «on twos» (Moho's `interval` / Rive's `quantize`).

## 8. What the timeline looks like (2026-11-06)

We debated between Rive (the hierarchy of everything animated, only properties with keys) and Moho (the channels of the
selection, with or without keys). To avoid cluttering the interface, **we start like Moho**:

- At the top, an **«All keys»** row with all the clip's keyframes in gray, to see the rhythm (click = move the
  playhead there).
- Below, **the channels of the selected object or bone, always all** of its animatables, including those without
  keyframes (dimmed, with ◇ to key that channel at the playhead). With no selection, the animated objects are listed to
  go to them.
- Channels as in Moho: **Position** (x and y together) and **Scale** (scaleX and scaleY together) are a single row; picking,
  moving, changing the curve or deleting a keyframe acts on both. In the data they are still separate tracks (what
  the AI sees does not change).
- All keyframes are **◆**, as in Moho; the **color tells the curve** of the segment leaving it: green linear,
  violet ease, amber step, light blue cubic-bezier, white if the channel's properties have different curves.
- **Several at once, as in Rive** (user request the same day): each selected thing (in Layers with Ctrl +
  click or Shift + click, or with Ctrl + click on the canvas bones, also in Manipulate, poses and clips) is a
  **collapsible group** in the timeline. The group's row summarizes its keyframes; ▸/▾ opens it and shows its channels as
  above. To avoid clutter, only the main one (the last picked) starts open; what the user opens or closes is
  remembered for the session. «◆ Key» keys all the selected ones in a single undo step.
- **Params are Puppet-only** (2026-11-06, user decision): the Parameters panel is only in Puppet and
  an Animate scene does not animate params (validation rejects it, also through the MCP). A scene keys the values
  themselves or copies a pose with «◆ Pose…» / `set_keys` with `pose`. Also, **a scene is shown without drivers** (§4,
  point 5).
- **The bottom panel is only the timeline** (2026-11-06): Parameters moved to the right panel, only in Puppet. Above the timeline, tabs like the document tabs: in Animate one per scene (+ creates one,
  × deletes it with confirmation), in Puppet the open clip (× closes it). The bar has playback in the middle:
  « (previous keyframe), ▶ and » (next keyframe); on the left the clock, the duration and the loop; on the right
  the keying buttons and the curve.
- The other half of Rive remains open: seeing everything animated without selecting it (today, with no selection, the timeline lists
  the animated objects to pick them).

## 9. Live Puppet (phase 6, 2026-11-11)

We debated building a state machine like Rive's (states, transitions with conditions on params, exit time,
1D blend). **User decision: it is on hold.** In an app with an LLM, the LLM already decides the state («I am
talking» → `play("talking")`) and what happens frame by frame (mouth with the audio, blinking, breathing) needs no
states. The state machine is more useful for games or apps without AI; it is picked up again if that case appears. What follows is equivalent to a
Rive state machine with transitions from *Any State*, so it does not close the door or lose anything on export.

### The runtime (`src/core/live.js`)

It is «the puppet running» and the same one that phase 7 exports. It does not depend on the DOM and advances with `advance(dt)` (tests and
scripts with fixed times). The app talks to it with three verbs:

- **`play(clip)`**:
  - a clip in `loop` or `pingpong` becomes **the base** (rest, listening, talking) and replaces the previous one
    with a crossfade;
  - a `once` clip is a **gesture**: it enters with a fade **on top of** the base, overrides only the tracks it has (the
    wave moves the arm and leaves the mouth from «talking») and leaves by itself with another fade at the end. Triggering it again
    restarts it. Several gestures stack in the order they were triggered.
- **`set(param, value)`**: the app's value (those missing, their initial value).
- **`stop(clip)`** (or `stop()` for everything): the clip leaves with its fade.

New clip data (`animation`, only in Puppet):

| Property | What it does |
|---|---|
| `fade` | Seconds of the fade in and out (default 0.2; 0 = abrupt, for blinking). The fade curve is smooth (ease-in-out). |
| `next` | Clip triggered when this `once` starts leaving: `start_talking` → `talking`, `surprised` → `idle`. |
| `blend` | `override` (default) overrides what is below with its weight; `additive` **adds** the difference from the setup (breathing: `scaleY` 1.02 adds 0.02 to whatever is there). What is not a number is not added. |
| `auto` | Procedural layers, character data: `off` (default, the app triggers it), `repeat` (the runtime triggers it by itself every `repeat_min`…`repeat_max` seconds at random: blinking) or `always` (always plays in loop: breathing, usually additive). The app does not trigger them. |

### How it blends (each frame)

```
setup → bases (crossfade) → gestures in order → auto layers → additives add → drivers with the blended params
```

- Each layer overrides what is below **with its weight**: numbers linearly, colors per channel, vertices like the morph, the
  discrete (a switch's child, booleans) changes when the weight passes 0.5.
- **App params against a clip that animates them:** they blend the same way, with the clip's weight. While it plays at weight 1
  the clip wins; when it leaves, the param returns **smoothly** to the app's value (if the app changed it meanwhile, the
  new one appears). Drivers are computed **once**, with the params already blended: poses are not blended twice.
- `auto` layers go on top of gestures: blinking is seen during a wave too.

### In the editor: «▶ Live» (Puppet)

A toggle above the clip library. With Live on, the document is not edited: the clip buttons
**trigger** (the `auto` ones are shown but play by themselves), the Parameters sliders are the app's values
(not saved and not added to the history), the timeline shows what is playing with its weight («■ Stop all» = `stop()`) and the canvas
is what the app will see. Turning it off goes back to what was open, with the previous Parameters values. «Live
is not edited» applies to the person: the AI's changes through MCP and undo do change the document, and the puppet continues
with the new one. «AI view» (also outside Live) shows the manifest, like `get_manifest`.

**Audit adjustments (2026-11-11):** bases are averaged among themselves during the crossfade and that blend overrides
the setup with the total weight (before, two equal bases let the setup show through halfway through the fade); the fade of a
`once` clip does not exceed half of its duration; an `auto: "always"` plays in loop even if the clip says `once`; asking again
for a base that is leaving resumes it; `stop` of an id that does not exist or of an auto gives an error; `next` in an `auto`
clip is a validation error.

### For the AI

- **Editing (MCP):** `set_keys` accepts `fade`, `next`, `blend`, `auto`, `repeat_min` and `repeat_max` (or `apply_ops`).
  `render_preview` with **`live`** (a script: `[{ t, play | stop | set }]`) and `times` returns the strip of frames of
  what the app would see, with the state of each frame (what is playing and at what weight). The blinking randomness uses a fixed
  seed, so the same script gives the same strip.
- **Manifest** (`get_manifest`, `manifest()` in `src/core/manifest.js`): what the app's AI reads. The params
  (type, range or options, initial value, description and **which poses each one moves**), the clips that can be
  triggered (base or gesture, description, duration, `next`, which params it animates) and the automatic layers (informational only).
  The param gains `description` for this. Phase 7 turns it into tools for the LLM (`play`, `set`, `stop`).

### Left for later

State machine (on hold), explicit region masks (today a clip already overrides only its tracks), recording a performance
(● Rec), keyboard shortcuts per button and lip-sync from audio (phase 7: it is a param the app moves).

## 10. The Puppet UI: three pieces in a single panel (2026-11-12)

The user confused the «View» dropdown at the top (Setup / Parameters (blend) / Pose: …) with a shortcut for the
clips: the three Puppet pieces were in three places and with different metaphors, and it was not visible that **params
blend poses**. It was agreed (like Rive's animation and input lists and Moho's actions as assets):

- **One right panel with the three pieces, stacked and collapsible:** Clips (what the puppet does; on top, because it is what
  is used most and what is triggered in Live), Parameters (knobs that blend poses) and **Poses** (still shots). Poses
  are a list like the clips one: click opens the pose for editing (yellow) and each row says which param moves it
  (← happiness). Tabs were ruled out: they take less space, but hide the relation.
- **No «View» dropdown.** A **banner above the canvas** says what is being edited or viewed, in the frame's color, with
  the button to exit: «Editing pose happy · Done», «Editing clip wave at 0.5 s · Close clip», «Previewing
  parameters · Reset» or «● Live · ■ Stop Live» (like Moho's notice when editing an action).
- What is collapsed is remembered per section. The MCP does not change: it is only the interface.
- **The inspector also collapses**, in every mode (arrow in the «Inspector» title; remembered). We tried putting
  Clips, Parameters and Poses in their own column next to the inspector and the user preferred to go back: with a
  collapsible inspector, each person decides how much space to give each thing.
- **Order and look** (also a user request): Clips → Poses → Parameters → Inspector; each Puppet header with + and 🗑
  like Layers and a darker background so it is clear where each section starts (not the inspector: it is the same in every
  mode). Each param on three lines: name and
  value; the full-width slider; the poses it blends with their weight and a + to connect another.
- **A small bar above Clips:** «Reset · ▶ Live · AI view», what is done with the whole puppet and not with a list
  (in the Clips header they broke the look). Reset returns the params to their initial value (with Live, the app's) and
  exits the params-view banner.
