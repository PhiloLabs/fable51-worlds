---
name: new-world
description: Use when starting a new world in fable51-worlds - a browser reconstruction of a real place. Walks from a place name to a manifest, ingested data, a geo blockout, and a first camera-match pass, in the order that catches errors earliest.
---

# Starting a new world

The README says "more worlds coming" and there is no path for adding one. This is
that path. It front-loads the two decisions that are expensive to change later —
the bounds and the coordinate frame — and it gets real data on screen before any
architecture is authored.

## 1. Bounds and frame, before anything else

Pick a bbox that preserves the sightlines that make the place recognisable, not
just the headline landmark. Union Square needed the surrounding blocks so the
square would not read as a plaza floating in space; Higashiyama needed the whole
2.3 km route so it could be walked without a loading screen.

Pick an origin that is a **physically identifiable object**, not a nominal centre —
the Dewey Monument footprint centroid, the Yasaka Pagoda centroid. When someone
later disputes a position, an origin you can point at settles it. The existing
briefs' suggested plaza-centre coordinates were both wrong by 6 m and 186 m
respectively; the OSM footprint centroids were right.

Set `gridBearingDeg` to the street grid if the place has a strong one, or 90 for a
plain east/south frame.

Write `ingest/worlds/<id>.json`. Copy an existing manifest and read its comments —
they explain why each source is declared the way it is.

## 2. Ingest, then look at what you got

```bash
node ingest/bin/ingest.mjs sources        # what is available, what needs a key
node ingest/bin/ingest.mjs fetch <id>     # dry run, prints counts per source
node ingest/bin/ingest.mjs build <id>     # writes the dataset + ATTRIBUTION + UNCERTAINTY
```

Read the counts before proceeding. A world with 30 buildings where you expected 400
means the bbox or the frame is wrong, and every hour spent on architecture before
noticing is wasted.

Read `UNCERTAINTY.md` now, not later. It lists every measurement where sources
disagreed. Adjudicate them while the world is still cheap to change.

**Region matters.** `usgs-3dep` only answers inside the US; `gsi-dem` and `plateau`
only inside Japan. Set `region` correctly or the elevation source silently skips
and the world comes out flat. If your place is in neither, you need a new elevation
adapter — Copernicus GLO-30 covers the globe at 30 m, which is coarse but honest.

## 3. Blockout, and stop there

Terrain, streets, plaza, building massing. Nothing else. No facades, no props, no
crowds.

Author 8–12 viewpoints at the positions a visitor would actually recognise, render
them, and compare against the `referenceImages` the ingest already collected.
Correct the geometry until the massing is recognisable. Everything downstream
inherits these errors, and they get more expensive to fix at every stage.

## 4. Then parallelise

Once the blockout holds, the work fans out and should run concurrently:

- one `recon-sector` agent per sector
- one `facade-author` per block, once its sector's recon lands
- asset generation per family (street furniture, vegetation, vehicles, retail)
- `qa-camera-match` on every render cycle
- `qa-provenance` before anything is called finished

Give each agent a scope, the files it may modify, a deliverable and a verification
method. Do not let a builder grade its own work.

## 5. The bar

`union-square-sf/PROMPT.md` states it and it has not moved: stop when the world
survives independent geographic, architectural, storefront, interaction, visual and
performance review — not when it compiles, and not when it is merely recognisable.
