# Rogue Squadron — The Battle of Yavin

A complete 190-second browser space battle built with Three.js, WebGL, GLSL and TypeScript. All spacecraft, station geometry, procedural textures, stars, lasers, explosions and audio are generated locally. No external models, audio downloads, game accounts or API keys are required. The generated social-sharing card is metadata only; it is never used as the 3D scene.

## Run

```sh
npm install
npm run dev
```

Open the local URL printed by the development server. The application uses the Sites-compatible vinext/Vite React structure. To build for production, run `npm run build`, then `npm run start`.

## Play

Choose **Launch mission** to fly the final trench run, or **Watch cinematic** for the complete autonomous sequence. Formation assistance flies the approach and cinematic transitions in either mode. Manual control begins at 01:08.

| Control | Action |
| --- | --- |
| W A S D / arrow keys | Horizontal and vertical flight |
| Q / E | Roll |
| Shift | Boost |
| Space | Fire laser cannons |
| T | Launch torpedoes after target lock |
| C | Toggle autopilot |
| P / Escape | Pause / resume |

On touch screens, drag the flight pad and use the on-screen fire and boost controls. The timeline and chapter menu revisit any scene. Settings offer three rendering quality levels, audio and camera motion. Automatic flight assistance completes the torpedo shot if no manual launch is made; shield damage is recoverable so the cinematic can always reach its ending.

## Sequence

- 00:00 — space approach and squadron formation
- 00:14 — close tracking shot and S-foil deployment
- 00:29 — fighter interception
- 00:49 — dive onto the station surface
- 00:58 — trench entry
- 01:08 — playable trench run with fighters, defenses and obstacles
- 02:00 — targeting and exhaust-port lock
- 02:17 — twin torpedoes launch, curve into the port and travel internally
- 02:25 — escape
- 02:38 — internal failure, core ignition and structural breakup
- 02:46 — primary volumetric explosion, shockwaves and glowing debris
- 03:08 — mission complete

## Implementation

- `app/experience/engine.ts`: mission state, camera director, arcade flight, combat, torpedo choreography, post-processing, lifecycle.
- `app/experience/vehicles.ts`: merged procedural X-wing/TIE geometry, PBR textures, S-foil animation and GLSL exhaust.
- `app/experience/environment.ts`: multiscale station shaders, actual recessed superlaser dish, instanced machinery, pooled modular trench and tracking defenses.
- `app/experience/effects.ts`: procedural sky, pooled combat effects, raymarched fireball, gas shells, shock fronts and GPU debris.
- `app/experience/audio.ts`: original Web Audio engine ambience, score and sound effects.
- `app/page.tsx`, `app/globals.css`: launch screen, flight HUD, controls, settings, briefing and responsive layout.

Desktop Chrome with WebGL2 is the primary target. The scene has adjustable resolution and optional bloom for lower-powered devices. The software is an original fan-made experience inspired by a fictional space battle; it is not an official Lucasfilm product.

## Verification

The `qa/` directory holds screenshots and reports from three visual passes, control tests and a continuous full mission run. The QA scripts use Playwright with an installed Chrome (`channel: 'chrome'`). `npx tsc --noEmit` checks TypeScript; `npm run build` produces the deployment artifact. See `qa/VERIFICATION.md` for final results.
