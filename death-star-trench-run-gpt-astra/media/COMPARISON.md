# Death Star trench run: GPT-6 Astra and Claude Fable 5.1

This is the **Codex / GPT-6 Astra one-shot submission** for the fable51-worlds evaluation:
*Rogue Squadron*, a 190-second browser Battle of Yavin built with Three.js, WebGL, GLSL and
TypeScript. "One-shot" identifies one submitted build; the autonomous build itself included
its own parallel agents and QA iterations, and its report retains the defects it found.

The Astra world was built before the Fable reel existed. This publication pass adds recording
tooling and this document; it does not rebuild the scene to match Fable.

## Comparison method

The Fable side is the **unedited 28.2-second Fable reel**
([`../../death-star-trench-run/media/trench-run.mp4`](../../death-star-trench-run/media/trench-run.mp4)),
which is itself a twelve-shot cut of that world's 3:12 sequence.

The Astra side was filmed to that reel's **shot order and timing**: for each beat of the Fable
cut, the Astra mission is seeked to its own corresponding moment and played forward at the
matching rate, so both panels hit the same story beat at the same second. The two missions run
190 s and 192 s respectively and reach comparable beats, which is what makes the alignment
possible.

**This is not a camera-matched comparison.** The two worlds are independent builds with
different geometry, scale, camera paths, phase timings and lighting. Where a beat lasts longer
in one mission than the other, the source range is compressed or expanded to fill the shot, so
the two sides are not playing at identical rates within a shot.

| Reel time | Beat | Astra source range |
|---|---|---|
| 0.0-2.4 s | Station approach | 0-7 s |
| 2.4-4.8 s | Squadron | 16-21 s |
| 4.8-6.6 s | Starfighter tracking | 24-29 s |
| 6.6-9.0 s | Interception | 32-37 s |
| 9.0-11.4 s | Surface dive | 49-58 s |
| 11.4-13.8 s | Trench entry | 69-74 s |
| 13.8-15.6 s | Surface defenses | 85-89 s |
| 15.6-18.2 s | Final trench run | 112-117 s |
| 18.2-19.0 s | Target lock | 132-137 s |
| 19.0-20.4 s | Torpedoes | 137-145 s |
| 20.4-21.1 s | Escape | 145-158 s |
| 21.1-21.6 s | Internal failure | 158-166 s |
| 21.6-25.8 s | Explosion and shockwave | 166-178 s |
| 25.8-28.2 s | Debris and flypast | 178-186 s |

Both panels are rendered at 640×360 and stacked without cropping or additional grading, under a
48-pixel label strip. **Astra is on the left, Fable on the right**, as in the Union Square and
Kyoto evaluations. Neither side's HUD, captions or post-processing is altered - the Fable panel
keeps its letterbox and targeting overlay, the Astra panel keeps its own.

## Reproduce

From this directory, with the Fable reel present in the sibling world:

```sh
npm install
node scripts/capture-comparison.mjs   # films the Astra mission to the reel's beats
python3 scripts/encode-comparison.py  # composites both panels and writes the GIF
```

The recorder bundles the mission engine with esbuild, parks its animation loop, and drives it
frame by frame through a seek-and-render hook, so each recorded frame comes from the normal
renderer rather than a screen capture. It reads the real canvas via `captureStream(30)`.
`capture-report.json` records per-second telemetry and any runtime errors.

The encoder expects the Fable MP4 at
`../../death-star-trench-run/media/trench-run.mp4`; the copy in this repo is the same file.

## Files

| | |
|---|---|
| [`fable51-vs-gpt6-astra-trench-run.mp4`](fable51-vs-gpt6-astra-trench-run.mp4) | The full side-by-side, 28.2 s, 1280×408 |
| [`preview.gif`](preview.gif) | Two-beat excerpt used as the poster in the root README |
| [`rogue-squadron-highlight.gif`](rogue-squadron-highlight.gif) | The Astra mission on its own |
| [`comparison-edit-plan.json`](comparison-edit-plan.json) | The shot table above, as the recorder consumed it |
| [`comparison-labels.png`](comparison-labels.png) | The label strip |

## Source material

- [Fable trench run source and reel](../../death-star-trench-run/)
- [Fable camera shot list](../../death-star-trench-run/src/camera/shots.ts)
- [Union Square comparison convention](../../union-square-sf-gpt-astra/)
- [Kyoto comparison convention](../../kyoto-higashiyama-gpt-astra/media/COMPARISON.md)

All footage is rendered from the corresponding source world. No film footage, audio, models or
textures are used or redistributed by either build.
