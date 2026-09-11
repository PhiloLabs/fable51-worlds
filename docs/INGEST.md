# Data ingress

Every world is assembled from public datasets. This document is what each source
contributes, what it costs, and which parts have been proven to work.

```bash
node ingest/bin/ingest.mjs sources          # the table below, generated
node ingest/bin/ingest.mjs fetch <world>    # dry run — counts per source, writes nothing
node ingest/bin/ingest.mjs build <world>    # write the dataset + ATTRIBUTION + UNCERTAINTY
node ingest/bin/ingest.mjs refs <world>     # download camera-match reference photography
node ingest/bin/ingest.mjs verify <world>   # re-check provenance and licensing
```

---

## The problem this solves

Before this package, neither world could be rebuilt from a clean clone.

`union-square-sf/tools/geo/build_gis.mjs` reads `src/data/recon/osm_raw.json` to
produce the committed `gis.json`. That input is listed in `.gitignore`. So the
script cannot run for anyone who clones the repo, and the 1.4 MB of geometry the
world depends on has no reproducible producer. `kyoto-higashiyama` is further along
the same road: its `src/data/geo.json` carries a `sources` block naming an Overpass
snapshot and ~200 GSI elevation queries, but there is no fetch script at all — the
file is an artefact of a session that no longer exists.

Both worlds' data is almost certainly correct. Neither is *checkable*, which for a
project whose whole claim is "researched and quality-checked end to end" is the
gap worth closing first.

`ingest build <world>` closes it. Two people who clone the repo and run it get the
same data, and every record names the dataset, licence and fetch time it came from.

---

## Sources

| Source | Licence | Region | Key? | Contributes |
|---|---|---|---|---|
| `osm-overpass` | ODbL-1.0 | any | no | building footprints, street centrelines, POIs |
| `overture` | ODbL-1.0 | any | no* | building heights, roof shapes, brand-resolved places |
| `usgs-3dep` | US-PD | us | no | bare-earth ground elevation (3DEP) |
| `usgs-lidar-lpc` | US-PD | us | py | **measured** building heights from the lidar point cloud |
| `gsi-dem` | JP-GOV-2.0 | jp | no | bare-earth ground elevation (1 m lidar) |
| `plateau` | JP-GOV-2.0 | jp | no | LOD2 city models, building usage, year built |
| `wikidata` | CC0-1.0 | any | no | landmark dimensions and dates, as cross-checks |
| `wikimedia-commons` | CC-BY-SA-4.0 | any | no | camera-match reference photography |
| `gtfs` | CC-BY-4.0 | any | no | transit stops, routes, track alignments |
| `mapillary` | CC-BY-SA-4.0 | any | yes | street-level imagery and sign detections |

\* `overture` needs the DuckDB CLI locally (`brew install duckdb`), not an API key.
"py" = needs `pip3 install 'laspy[lazrs]' pyproj numpy`. It is the only non-Node step
in the package and is optional in every manifest.

### `usgs-lidar-lpc` — the only source that MEASURES a height

Every other height here is an estimate: OSM's `height` is hand-entered,
`building:levels` x an assumed storey height is a guess, Overture's is model-derived.
This one takes the roof plane (p50 of returns inside the footprint, inset 2.5 m) minus
the ground (p05 of an annulus outside) from the actual point cloud.

It exists because of Davis Library. OSM had no height and no levels; Overture supplied
**11.73 m for an eight-floor building** — 1.47 m per storey, wrong by 2.3x, on the
subject of the world. Nothing could catch it: both corpora were silent on floor count
so the storey gate could not fire, and 11.73 m sat unremarkably against a bbox median
of 10.8 m.

The lidar settles it: **28.77 m from 7,676 roof returns**, and Overture's figure is
retained as a recorded conflict at a 59% delta rather than discarded.

Two independent validations of the method, neither of them targeted:

- the lidar ground ring reads 143-145 m where 3DEP's bare-earth DEM independently
  reads **144.35 m** at the same centroid;
- the **Morehead-Patterson Bell Tower** decomposes to a 20.69 m base roof plus 30.98 m
  of "rooftop plant" (the tower shaft) = **51.67 m**, against a published **172 ft
  (52.43 m)** — within 1.5 %.

Percentiles, not extremes, on purpose. The maximum return inside a footprint is
mechanical plant or a parapet; Davis reads 172.03 m at p50 and 178.79 m at max, and
that 6.76 m gap is real rooftop plant, not the building. `rooftopPlantM` is reported
separately so a facade builder can use it or ignore it.

**Coverage is the catch.** 3DEP LPC is not nationwide, and vintage varies wildly — the
Chapel Hill tile is `NC_PHASE1B_2001`, flown in 2001. A building put up after the
survey is absent; one demolished since is still there. The adapter reports the survey
date per tile and refuses to emit a height it cannot derive. On the UNC campus core it
measured **90 of 113** buildings; the other 23 had too few returns and are listed in
`lidarSkipped` rather than guessed at.

### What is verified, and what is not

Measured on 2026-09-03 from a laptop:

| Source | Status | Evidence |
|---|---|---|
| `osm-overpass` | **verified** | 453 buildings / 707 streets / 748 POIs for union-square-sf — the 453 matches `FINAL_QA_REPORT.md`'s "453 OSM building footprints loaded" exactly. 4,728 buildings for kyoto-higashiyama. |
| `overture` | **verified** | 420 buildings + 3,132 places for union-square-sf against release `2026-08-19.0`. Cold query 249 s; cached thereafter. |
| `usgs-3dep` | **verified** | Returns `23.940353394` m at the Dewey Monument, matching the committed `ORIGIN_ELEVATION_M = 23.94`. 1 m raster, acquired 2023-03-04. |
| `gsi-dem` | **verified** | Returns `61.3` m at the Yasaka Pagoda, matching `geo.json`'s `ground_elev_m: 61.3`. Layer `1m（レーザ）`. |
| `wikidata` | **verified** | 73 measured landmarks in the SF bbox, 45 in the Kyoto bbox. |
| `wikimedia-commons` | **verified** | 198 licence-clean references across 5 SF viewpoints; 15 downloaded and confirmed as valid multi-megapixel JPEGs. |
| `plateau` | **partial** | CKAN resolution verified — `plateau-26100-kyoto-shi-2025` returns 6 resources including CityGML v5 and 3D Tiles. CityGML *parsing* (`parseCityGmlBuildings`) is written but **not exercised against a real bundle**; the download is off by default. |
| `gtfs` | **unverified** | CSV parsing is unit-tested against fixtures. The download is **not** proven: `gtfs.sfmta.com` refused TCP from the machine this was written on (DNS resolved, connection timed out). Treat the SFMTA URL as unconfirmed. |
| `mapillary` | **unverified** | No `MAPILLARY_TOKEN` was available. Code path untested end to end. |

---

## What each source is actually for

### `overture` — the storefront problem

`union-square-sf/FINAL_QA_REPORT.md` lists **33 UNRESOLVED storefronts**, several on
the square's most visible frontages: 384 Post St (the former Saks), 225 Post St (the
former Burberry), 200 Stockton St (the former Bulgari). The report is honest about
them and they render as blank fascias, which is the correct behaviour — but it is a
gap, and it is the largest measured one in the repo.

Overture's `places` theme merges Meta's and Microsoft's POI corpora with OSM and
attaches a per-record confidence score. In the Union Square bbox it returns **3,132
places** against a hand-built census of 122. `ingest/src/storefronts.mjs` merges the
two corpora conservatively:

- a name agreeing within ~20 m → **corroborated**, promoted to high confidence
- a *different* name nearby → recorded as a `conflict`, never silently preferred
- an Overture place with no OSM counterpart → `status: "candidate"`, not resolved
- anything below Overture's medium-confidence cut → **dropped**

On the current data that yields 748 resolved storefronts (262 corroborated by two
independent sources), 2,571 candidates and 513 flagged conflicts. The candidates are
the pool a recon agent works through for the unresolved bays; nothing is promoted to
rendered signage without a second source, because the brief is explicit: *do not
hallucinate a famous brand into an unknown location.*

Overture's `buildings` theme also carries `height`, `num_floors` and `roof_shape` on
far more features than raw OSM tags, which is exactly what `FacadeBuilder` currently
guesses at.

### `plateau` — the Kyoto opportunity

The largest available accuracy upgrade for `kyoto-higashiyama`, and currently
unused. The world is built from OSM footprints plus ~200 GSI point queries, with
every roof, eave and storey count authored by hand from cultural-property records —
an enormous amount of careful work.

PLATEAU publishes, for Kyoto City specifically, an **LOD2 building model**: real
roof geometry rather than extruded footprints, with per-building 用途 (usage) and
建築年 (year of construction). The FY2025 release adds **LOD3.3** for the model
districts. Free for commercial use under the 政府標準利用規約 2.0.

**What PLATEAU does not yet give us here.** The adapter resolves the catalogue and
records exactly which official release a world was built against — which is what
makes a claim like "the pagoda is 38.79 m" auditable. It does **not** yet lift the
LOD2 solids into GLB kit pieces. `parseCityGmlBuildings()` reads attributes and LOD0
roof-edge rings out of a `*_bldg_*.gml`, but it has not been run against a real
bundle, and turning CityGML solids into the world's toon-shaded kit is a substantial
piece of work, not a config change.

### `wikidata` — making the survey mechanical

`kyoto-higashiyama`'s README documents six figures where "the survey won and the
popular number lost". The Yasaka Pagoda is 38.79 m, not the universally repeated 46
(that figure is explicitly 公称, nominal). The Kiyomizu stage deck is at 115.5 m ASL,
not 240 — the 240 is the ridge *behind* the temple. The stage pillars are 0.64 m
across, not 2 m; the 2 m is a 周囲 (circumference) misread as a diameter.

Every one of those was caught by a human noticing a contradiction. Wikidata makes
half the check mechanical: P2048 (height), P2043 (length), P571 (inception) as typed
quantities with references. Feed those into `reconcile()` alongside the survey figure
and a disagreement becomes a row in `UNCERTAINTY.md` instead of a silently wrong
number.

`reconcile()` **never averages**. Averaging a correct survey figure with a
repeated-everywhere wrong one produces a number that is wrong in a new way. The
highest-confidence value wins and the loser is recorded with both sources.

### `wikimedia-commons` — reproducible ground truth

`refs/**/*.jpg` is gitignored, which is right: this project should not redistribute
other people's photographs. But it left the camera-match harness with no ground
truth on a fresh clone — the comparison pass simply could not run.

The fix is to commit the *manifest* and fetch pixels on demand. `ingest refs`
downloads them into the gitignored tree with a `SOURCES.md` recording each image's
licence and author, ranked by whether the photographer recorded a compass heading
(the only references you can properly align to) and then by resolution.

### `mapillary` — the licence-clean Street View

`PROMPT.md` draws the line correctly: Google Earth and Street View are visual
references, and their meshes and imagery must never ship. That leaves the repo with
no street-level imagery it may actually keep. Mapillary's is CC-BY-SA, exposes each
image's position and SfM-refined `compass_angle`, and runs its own detection layer —
so a storefront census can query for `object--sign--store` rather than eyeballing.

---

## Adding a source

Write one module in `ingest/src/sources/` and name it in a world manifest.

```js
export default {
  id: 'my-source',
  title: 'Human-readable dataset name',
  license: 'CC-BY-4.0',          // must exist in licenses.mjs
  attribution: 'Whoever made it',
  homepage: 'https://...',
  requires: [],                   // binaries or env vars a human must supply
  provides: ['buildings'],
  appliesTo: (world) => world.region === 'us',   // optional region gate
  available: () => Boolean(process.env.MY_TOKEN), // optional runtime gate
  async fetch(ctx) { return { raw, provenance }; },
  normalize(raw, ctx) { return { buildings: [...] }; },
};
```

`ctx` carries the world, the projection frame, a cache dir, and the manifest's
`options`. Use `fetchCached` / `fetchBinary` from `http.mjs` — they handle
throttling, retries, the disk cache and the provenance sidecar.

Register it in `sources/index.mjs`. The licence gate, the attribution file and the
CI manifest check pick it up automatically.

## Pin your releases

Overture is pinned to a dated release, PLATEAU to a fiscal-year dataset id. An
unpinned "latest" would make every rebuild produce different geometry, which
destroys the camera-match baseline. Bump deliberately, then re-run QA.
