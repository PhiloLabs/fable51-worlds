/**
 * overture — building heights, roof shapes and brand-resolved storefronts from the
 * Overture Maps Foundation's open GeoParquet releases.
 *
 * This is the highest-value new ingress in the repo, because it attacks
 * union-square-sf's largest documented defect head-on. FINAL_QA_REPORT.md lists
 * 33 UNRESOLVED storefronts — bays where the census could not establish who trades
 * there, rendered with neutral blank fascias. Overture's `places` theme carries
 * ~60M POIs with a `brand` block, a `categories` block and a per-record
 * `confidence` score, harvested from Meta and Microsoft's places corpora in
 * addition to OSM. Every place already arrives with the confidence field the
 * storefront census had to assign by hand.
 *
 * The `buildings` theme is the other half: 1.3B footprints that merge OSM with
 * Microsoft and Esri building models, and — crucially — carry `height`,
 * `num_floors` and `roof_shape` on far more features than raw OSM tags do. Where
 * OSM leaves a height null, FacadeBuilder currently guesses from storey count;
 * Overture often just knows.
 *
 * Access is by SQL over HTTP range reads against the public S3 bucket. No key, no
 * account, no bulk download: DuckDB's parquet reader fetches only the row groups
 * the bbox predicate touches, so a downtown-sized query moves tens of megabytes
 * rather than the ~400 GB release.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const exec = promisify(execFile);

/**
 * Overture cuts a release roughly monthly, tagged `YYYY-MM-DD.N`. Pinning it is
 * deliberate: an unpinned "latest" would make every rebuild of a world produce
 * different geometry, which is exactly the non-reproducibility this package exists
 * to remove. Bump it consciously and re-run the camera-match QA.
 */
export const DEFAULT_RELEASE = '2026-08-19.0';
const S3_BASE = 's3://overturemaps-us-west-2/release';

async function haveDuckdb() {
  try {
    await exec('duckdb', ['--version']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run one SQL statement through the DuckDB CLI and parse its JSON output, caching
 * the result on disk.
 *
 * The cache matters more here than for any other adapter. DuckDB range-reads the
 * planet-wide parquet index on every query, so a cold Union Square fetch measured
 * 249 s against the 2026-08-19.0 release. Because the query text pins the release
 * and the bbox, hashing it is a sound cache key: the same key can only ever mean
 * the same immutable release.
 */
async function duckdbJson(sql, { cwd, cacheDir, refresh, maxAgeMs = Infinity, log }) {
  const key = createHash('sha256').update(sql).digest('hex').slice(0, 40);
  const cachePath = path.join(cacheDir, `${key}.json`);
  if (!refresh) {
    try {
      const st = await fs.stat(cachePath);
      if (Date.now() - st.mtimeMs <= maxAgeMs) {
        log?.(`cache hit (${path.basename(cachePath)})`);
        return JSON.parse(await fs.readFile(cachePath, 'utf8'));
      }
    } catch { /* miss */ }
  }
  const { stdout } = await exec('duckdb', ['-json', '-c', sql], { cwd, maxBuffer: 512 * 1024 * 1024 });
  const trimmed = stdout.trim();
  const rows = trimmed ? JSON.parse(trimmed) : [];
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(cachePath, JSON.stringify(rows));
  return rows;
}

const PRELUDE = `INSTALL spatial; LOAD spatial; INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';`;

function buildingsSql(bbox, release) {
  return `${PRELUDE}
SELECT
  id,
  names.primary                       AS name,
  height,
  num_floors,
  roof_shape,
  roof_material,
  class,
  subtype,
  sources[1].dataset                  AS source_dataset,
  ST_AsText(geometry)                 AS wkt
FROM read_parquet('${S3_BASE}/${release}/theme=buildings/type=building/*', hive_partitioning=1)
WHERE bbox.xmin BETWEEN ${bbox.west} AND ${bbox.east}
  AND bbox.ymin BETWEEN ${bbox.south} AND ${bbox.north};`;
}

function placesSql(bbox, release) {
  return `${PRELUDE}
SELECT
  id,
  names.primary                       AS name,
  confidence,
  categories.primary                  AS category,
  brand.names.primary                 AS brand,
  brand.wikidata                      AS brand_wikidata,
  addresses[1].freeform               AS address,
  websites[1]                         AS website,
  ST_X(geometry)                      AS lon,
  ST_Y(geometry)                      AS lat
FROM read_parquet('${S3_BASE}/${release}/theme=places/type=place/*', hive_partitioning=1)
WHERE bbox.xmin BETWEEN ${bbox.west} AND ${bbox.east}
  AND bbox.ymin BETWEEN ${bbox.south} AND ${bbox.north};`;
}

/** Minimal WKT POLYGON parser — Overture geometry is always POLYGON or MULTIPOLYGON. */
function wktOuterRing(wkt) {
  if (!wkt) return null;
  const m = wkt.match(/\(\(([^)]*)\)/);
  if (!m) return null;
  return m[1].split(',').map((pair) => {
    const [lon, lat] = pair.trim().split(/\s+/).map(Number);
    return { lat, lon };
  });
}

export default {
  id: 'overture',
  title: 'Overture Maps Foundation — buildings and places',
  license: 'ODbL-1.0',
  attribution: '© Overture Maps Foundation; incorporates © OpenStreetMap contributors',
  homepage: 'https://docs.overturemaps.org/',
  requires: ['duckdb CLI (brew install duckdb)'],
  provides: ['buildings', 'places', 'heights', 'roof-shapes', 'brands'],

  async fetch(ctx) {
    if (!(await haveDuckdb())) {
      throw new Error(
        'overture needs the DuckDB CLI. Install it with `brew install duckdb` ' +
          '(or see https://duckdb.org/docs/installation/), then re-run. ' +
          'This source is optional — `ingest fetch --skip overture` builds without it.',
      );
    }
    const release = ctx.options?.release ?? DEFAULT_RELEASE;
    const bbox = ctx.world.bbox;
    const scratch = path.join(ctx.cacheDir, 'overture');
    await fs.mkdir(scratch, { recursive: true });

    const q = { cwd: scratch, cacheDir: scratch, refresh: ctx.refresh, maxAgeMs: ctx.maxAgeMs, log: ctx.log };
    ctx.log?.(`overture: querying release ${release} (buildings)`);
    const buildings = await duckdbJson(buildingsSql(bbox, release), q);
    ctx.log?.(`overture: ${buildings.length} buildings; querying places`);
    const places = await duckdbJson(placesSql(bbox, release), q);
    ctx.log?.(`overture: ${places.length} places`);

    return {
      raw: { release, buildings, places },
      provenance: { url: `${S3_BASE}/${release}`, release, counts: { buildings: buildings.length, places: places.length } },
    };
  },

  normalize(raw, ctx) {
    const { frame, world } = ctx;
    const r2 = (v) => Math.round(v * 100) / 100;

    const buildings = [];
    for (const b of raw.buildings) {
      const ring = wktOuterRing(b.wkt);
      if (!ring || ring.length < 4) continue;
      buildings.push({
        id: `overture/${b.id}`,
        footprint: ring.map((p) => {
          const l = frame.geoToLocal(p.lat, p.lon);
          return [r2(l.x), r2(l.z)];
        }),
        heightM: b.height ?? null,
        levels: b.num_floors ?? null,
        roofShape: b.roof_shape ?? null,
        roofMaterial: b.roof_material ?? null,
        name: b.name ?? null,
        class: b.class ?? null,
        subtype: b.subtype ?? null,
        upstreamDataset: b.source_dataset ?? null,
      });
    }

    /**
     * Overture assigns every place a confidence in [0,1]. Map it onto the
     * high/medium/low vocabulary the storefront census already uses so the two
     * datasets can be merged without inventing a third scale. The 0.75/0.5 cuts
     * match where Overture's own docs describe the drop-off from "corroborated by
     * several sources" to "single source".
     */
    const bucket = (c) => (c == null ? 'low' : c >= 0.75 ? 'high' : c >= 0.5 ? 'medium' : 'low');

    const places = [];
    for (const p of raw.places) {
      if (!frame.inBbox(world.bbox, p.lat, p.lon)) continue;
      const l = frame.geoToLocal(p.lat, p.lon);
      places.push({
        id: `overture/${p.id}`,
        name: p.name ?? null,
        brand: p.brand ?? null,
        brandWikidata: p.brand_wikidata ?? null,
        category: p.category ?? null,
        address: p.address ?? null,
        website: p.website ?? null,
        pos: [r2(l.x), r2(l.z)],
        geo: { lat: p.lat, lon: p.lon },
        confidence: bucket(p.confidence),
        confidenceRaw: p.confidence ?? null,
      });
    }

    return { buildings, places, overtureRelease: raw.release };
  },
};
