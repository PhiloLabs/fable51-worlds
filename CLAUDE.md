# fable51-worlds — working agreement for agents

Explorable browser reconstructions of real places. Each world is a plain Three.js
app; the reconnaissance, asset generation and QA that produced it all live in the
repo so they can be re-run.

`union-square-sf/PROMPT.md` is the original brief that produced the first world,
reproduced verbatim, and it remains the best statement of the quality bar. This
file is the operational counterpart: the rules that hold across every world, and
the harness that executes them.

---

## The five invariants

Violating any of these is a defect regardless of how the render looks.

1. **Reconstructed, never invented.** Every position, height and dimension traces
   to a named public dataset or a cited published survey. `ingest verify` fails the
   build on any record that cannot name its source.

2. **Reference-only sources never ship bytes.** Google Earth and Street View may be
   consulted to decide a number. Their meshes, tiles and imagery must never enter
   the repository. `ingest/src/licenses.mjs` encodes this: a source classed
   `restricted` cannot contribute to a built dataset. Mapillary (CC-BY-SA) is the
   licence-clean substitute for street-level imagery.

3. **Uncertainty is recorded, not resolved by averaging.** Where sources disagree,
   `reconcile()` picks the highest-confidence value and writes the loser into
   `UNCERTAINTY.md` with both figures and both sources. This is how the Higashiyama
   survey caught that the Yasaka Pagoda is 38.79 m and not the universally repeated
   46 m — the 46 m is a nominal figure, and averaging the two would have produced a
   number that is wrong in a new way.

4. **An unknown storefront stays blank.** If current occupancy cannot be
   established, reconstruct the architecture accurately and render a neutral
   fascia. Overture places that no second source corroborates are emitted as
   `status: "candidate"`, never as resolved signage. Do not put a famous brand at
   an address you have not verified.

5. **Visual verification is the only verification.** A milestone is not complete
   because the code compiles, the assets load, and the console is clean. Those are
   entry conditions. Run the app, capture the viewpoints, diff them against the
   references, and fix what the diff shows.

---

## Layout

```
ingest/                  data ingress: adapters, world manifests, provenance gate
  worlds/<id>.json       bbox, coordinate frame, declared sources — the world's spec
  src/sources/*.mjs      one module per public dataset
<world>/src/             the Three.js app
<world>/src/data/recon/  ingested data (generated — do not hand-edit)
<world>/tools/           per-world QA and asset generation
<world>/qa/              capture output and reviewer reports
.claude/agents/          the reconstruction and QA swarm
.claude/skills/          the repeatable procedures
```

## Commands

```bash
node ingest/bin/ingest.mjs sources            # every adapter, licence, what it needs
node ingest/bin/ingest.mjs build <world>      # fetch, merge, reconcile, write, verify
node ingest/bin/ingest.mjs verify <world>     # re-check provenance and licensing
node --test 'ingest/test/**/*.test.mjs'       # offline unit tests, must always pass

cd <world> && npm run dev                     # run the world
cd <world> && npm run qa:shots                # capture the reference viewpoints
```

## Data ingress

Adding a source means writing one module in `ingest/src/sources/` and naming it in
a world manifest. Nothing else changes. An adapter declares its licence,
attribution and external requirements up front, and exposes `fetch(ctx)` plus
`normalize(raw, ctx)`.

Sources currently wired: `osm-overpass`, `overture`, `usgs-3dep`, `gsi-dem`,
`plateau`, `wikidata`, `wikimedia-commons`, `gtfs`, `mapillary`. See
`docs/INGEST.md` for what each contributes and which are verified live.

**Pin your releases.** Overture is pinned to a dated release in the manifest and
PLATEAU to a fiscal-year dataset id. An unpinned "latest" would make every rebuild
produce different geometry, which destroys the camera-match baseline. Bump
deliberately, then re-run QA.

## Conventions

- The runtime is **Three.js only**. No game engine, no physics engine. Blender
  (`bpy`) is an offline asset tool; it must not appear at runtime.
- Coordinate frames come from `ingest/src/geo.mjs` via the generated
  `frame.generated.*`. Never restate the projection constants by hand — that
  duplication is what this module exists to remove.
- Generated files say so in their first line. Do not hand-edit them.
- `<world>/src/data/recon/*` is build output. Change the manifest or the adapter,
  not the JSON.

## Parallelism

The brief's instruction stands: at each milestone, ask which tasks can proceed
without waiting, and start all of them. The lead agent is an orchestrator and
integrator, not the sole implementer. Give each subagent a scope, the files it may
modify, a deliverable, and a verification method.

Agents must not grade their own work. Builder → independent reviewer → correction
→ independent re-review, for anything that matters.
