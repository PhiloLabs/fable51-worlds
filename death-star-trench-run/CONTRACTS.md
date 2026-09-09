# TRENCH RUN — module contracts

Everything is Three.js r0.185 + TypeScript + Vite. `import * as THREE from 'three'`.
Addons: `three/examples/jsm/...`.

## World scale — READ `src/core/constants.ts` FIRST
1 unit = 1 metre. X-wing 12.5 m. Death Star radius **50 000 m**, centred at world origin,
poles on ±Y. Camera near = 1.0, far = 700 000 — **no logarithmic depth buffer**, so never
place coplanar surfaces that are >50 km from the camera.

### Trench frame
The playable trench follows a meridian great circle in the world XY plane; +Z is lateral.
Use the helpers, never hand-rolled trig:
```ts
trenchToWorld(s, lateral, up, out)   // (arc-length m, lateral m, height above sphere m) -> world
trenchQuat(s, out)                   // orientation: local -Z = along trench, +Y = radial up, +X = world +Z
worldToTrench(worldPos, out)         // -> {s, lateral, up}
```
`TRENCH_HALF_WIDTH = 62`, `TRENCH_DEPTH = 105` (floor at up = -105), run spans
`s ∈ [-3000, 26200]`, exhaust port at `s = PORT_S = 24000`, `PORT_RADIUS = 11`.

## Shared utilities you MUST use (do not re-implement)
- `src/core/mathx.ts` — clamp/lerp/damp/dampV/dampQ/easings/smoothstep/spring
- `src/core/rng.ts` — `RNG` seeded PRNG (`next/range/int/bool/pick/gauss/fork`)
- `src/core/pool.ts` — `Pool<T>`
- `src/core/constants.ts` — scale, trench frame, colours
- `src/shaders/lib.ts` — GLSL chunks: `GLSL_HASH`, `GLSL_NOISE` (vnoise2/3, fbm2/3, ridged3,
  worley3, warp3), `GLSL_COLOR` (blackbody, plasmaRamp, luma), `GLSL_ROT`, `GLSL_PANEL`,
  `GLSL_PRELUDE`
- `src/world/greebleKit.ts` — procedural mechanical parts (`tower/vent/pipeRun/antenna/
  machinery/recess/plate/bridge/turretBase/turretHead/turretBarrels/box/slab/cyl/
  taperedCyl/greebleAtlas`). All parts are tagged with `aEmis` + `aMat` attributes.
- `src/world/hullMaterial.ts` — `createHullMaterial(opts)` PBR material that consumes those
  attributes and adds panel lines, grime, windows, damage glow. `updateHullMaterials(mats,t,damage)`.

If you build custom geometry that will use `createHullMaterial`, you must add the
`aEmis` and `aMat` float attributes (use the greebleKit `box/slab/cyl` helpers, which do it).

## Rendering rules
- HDR linear pipeline; ACES tone mapping + bloom happen in post. Emissive values **above 1.0**
  bloom. Aim: engines ~4–14, lasers ~15–40, torpedo core ~30, explosion core ~40+.
- Custom `THREE.ShaderMaterial` is fine (NOT RawShaderMaterial). Additive VFX should use
  `blending: THREE.AdditiveBlending, depthWrite: false, transparent: true`.
- No shadow maps. Lighting comes from one strong key `DirectionalLight`, a dim fill, and
  an `AmbientLight`; the integrator owns those — do not add your own scene lights except
  short-lived `PointLight`s for muzzle flashes/explosions (max ~4 alive at once).
- Budget: keep total draw calls under ~450 and triangles under ~4 M. Use `InstancedMesh`,
  shared geometry/material, and pooling.

## Deliverable rules
- Only create/modify the files assigned to you. Never edit another agent's files, never edit
  `src/main.ts`, `src/game/sequence.ts`, `src/camera/director.ts`.
- Export exactly the API named in your brief — the integrator calls it verbatim.
- TypeScript must pass `npx tsc --noEmit` in strict mode.
- Self-test by running `npx vite --port <your own port> --strictPort` and loading a scratch
  page, or by adding a temporary throwaway entry file that you delete afterwards.
