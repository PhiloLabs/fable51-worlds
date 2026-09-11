---
name: camera-match
description: Use when validating a world against reality - rendering authored viewpoints and diffing them against reference photography. Covers getting ground truth onto a fresh clone, what to compare, and what not to optimise for.
---

# Camera-match validation

The brief calls this mandatory and it is the only check that catches the errors
that matter: "Do not trust source code inspection. The final artifact is visual."

## Get ground truth first

On a fresh clone there are no reference images — `refs/**/*.jpg` is gitignored, and
correctly so. Materialise them from the committed manifest:

```bash
node ingest/bin/ingest.mjs build <world>                 # if ingest.json is absent
node ingest/bin/ingest.mjs refs <world> --per-viewpoint 6
```

This writes real photographs into `<world>/refs/<viewpoint>/` plus a `SOURCES.md`
recording each image's licence and author. References are ranked by whether the
photographer's compass heading was recorded, then by resolution — a reference with
a known heading is the only kind you can properly align to, and a small one cannot
resolve bay rhythm.

## Render

```bash
cd <world> && npm run qa:shots
```

## Compare structure, not pixels

This is the discipline the whole check depends on. Lighting, season, time of day,
foliage and traffic will never match, and the brief is explicit that optimising
toward pixel equality is wrong. Compute similarity metrics if you like, but let
them *complement* the visual read, never replace it.

Compare, in roughly this order of importance:

1. **Silhouette** — skyline, relative building heights, where the roofline steps
2. **Bay rhythm** — how many window bays per elevation, and their spacing. This is
   the strongest recognition cue at street level and the most commonly wrong.
3. **Storey count and cornice line** — off-by-one storeys are endemic when height
   came from a storey-count estimate rather than a measured figure
4. **Street and sidewalk width** — a street 2 m too wide reads as a different city
5. **Storefront position and signage placement**
6. Materials and tone, last

## Triage what you find

Rank by street-level visibility, not by measurement error. A 3 m height error on a
building nobody can see from the plaza matters less than a storefront on the wrong
side of a door on the frontage everyone photographs.

Trace every discrepancy back to a cause before proposing a fix:

- wrong in `ingest.json` → the upstream data is wrong or the wrong source won.
  Check `UNCERTAINTY.md`; the conflict may already be recorded.
- right in `ingest.json`, wrong on screen → the facade spec or the builder
- right in both, still wrong → the viewpoint's camera position or FOV is off, which
  is a QA bug and not a world bug. Fix the viewpoint and re-render.

## Do not grade your own repairs

The reviewer files findings; a correction agent applies them; a *different* review
pass confirms. `qa-camera-match` is the reviewer and must not edit the scene.

## When to stop

Not when the diff is small. Stop when someone who knows the real place would
recognise it from every viewpoint, and could tell which side of the square they are
standing on from the architecture alone.
