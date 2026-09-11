/**
 * usgs-lidar-lpc — measured building heights from the USGS 3DEP lidar point cloud.
 *
 * Every other height in this pipeline is somebody's estimate. OSM's `height` tag is
 * hand-entered, `building:levels` times an assumed storey height is a guess, and
 * Overture's height is model-derived. This adapter measures the building.
 *
 * It exists because of a specific failure. Building the UNC Chapel Hill world, OSM
 * way 44343213 (Walter Royal Davis Library) had neither height nor levels, and
 * Overture supplied 11.73 m for an eight-floor building — 1.47 m per storey, wrong
 * by 2.3x, on the subject of the world. Nothing could catch it: both corpora were
 * silent on floor count so the storey-plausibility check could not fire, and at
 * 11.73 m it sat unremarkably against a bbox median of 10.8 m.
 *
 * The lidar settles it. 8,384 returns inside the footprint put the roof plane at
 * 172.05 m and the surrounding ground at 145.07 m: **26.98 m**, or 3.37 m per storey
 * over eight floors. The 3DEP bare-earth DEM independently reads 144.35 m at the
 * centroid, agreeing with the lidar ground ring to within 0.7 m.
 *
 * COVERAGE IS THE CATCH. 3DEP LPC is not everywhere, and where it exists the
 * vintage varies enormously — the tile covering Chapel Hill is NC_PHASE1B_2001,
 * flown in 2001. A building put up after the survey simply is not in the cloud, and
 * one demolished since still is. The adapter reports the survey date per tile so a
 * reviewer can judge, and refuses to emit a height it cannot derive rather than
 * guessing. It is declared optional in every manifest for exactly this reason.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchJson } from '../http.mjs';

const exec = promisify(execFile);
const TNM = 'https://tnmaccess.nationalmap.gov/api/v1/products';
const WORKER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'tools', 'lidar_heights.py',
);

/**
 * Legacy 3DEP tiles frequently carry no CRS record — the Chapel Hill tile is LAS
 * 1.1 point format 0 with `parse_crs()` returning None — so the projection has to
 * be supplied. These are the State Plane zones the LPC projects use, keyed by the
 * state prefix in the USGS project name.
 */
const STATE_PLANE = {
  NC: 'EPSG:32119', // NAD83 / North Carolina, metres
  CA: 'EPSG:26943', // NAD83 / California zone 3
  NY: 'EPSG:32118',
  WA: 'EPSG:32148',
  TX: 'EPSG:32139',
};

async function haveDeps() {
  try {
    await exec('python3', ['-c', 'import laspy, pyproj, numpy']);
    return true;
  } catch {
    return false;
  }
}

export default {
  id: 'usgs-lidar-lpc',
  title: 'USGS 3DEP lidar point cloud — measured building heights',
  license: 'US-PD',
  attribution: 'U.S. Geological Survey, 3D Elevation Program',
  homepage: 'https://www.usgs.gov/3d-elevation-program',
  requires: ["python3 with laspy[lazrs], pyproj, numpy"],
  provides: ['measured-building-heights'],
  appliesTo: (world) => world.region === 'us',

  async fetch(ctx) {
    if (!(await haveDeps())) {
      throw new Error(
        'usgs-lidar-lpc needs python3 with laspy, pyproj and numpy. Install with ' +
          "`pip3 install 'laspy[lazrs]' pyproj numpy`, then re-run. This source is " +
          'optional — the build proceeds without it.',
      );
    }

    const { bbox } = ctx.world;
    const max = ctx.options?.maxTiles ?? 4;

    // 1. Ask The National Map which LPC tiles intersect the world.
    const url =
      `${TNM}?datasets=${encodeURIComponent('Lidar Point Cloud (LPC)')}` +
      `&bbox=${bbox.west},${bbox.south},${bbox.east},${bbox.north}&max=${max}`;
    const { json } = await fetchJson(url, {
      cacheDir: ctx.cacheDir, maxAgeMs: ctx.maxAgeMs, refresh: ctx.refresh, timeoutMs: 90_000,
    });
    const items = json.items ?? [];
    if (!items.length) {
      throw new Error(
        `no 3DEP lidar point-cloud coverage for this bbox. 3DEP LPC is not nationwide; ` +
          'skip this source for this world.',
      );
    }
    ctx.log?.(`${items.length} LPC tile(s): ${items.map((i) => i.title).join(', ')}`);

    // 2. Download them. These are large (the Chapel Hill tile is 80 MB), so they
    //    are cached by URL hash and never re-fetched.
    const dir = path.join(ctx.cacheDir, 'laz');
    await fs.mkdir(dir, { recursive: true });
    const tiles = [];
    for (const it of items) {
      const dl = it.downloadURL;
      if (!dl) continue;
      const file = path.join(dir, `${createHash('sha256').update(dl).digest('hex').slice(0, 16)}.laz`);
      let have = false;
      try { have = (await fs.stat(file)).size > 0 && !ctx.refresh; } catch { /* miss */ }
      if (!have) {
        ctx.log?.(`downloading ${it.title} (${((it.sizeInBytes ?? 0) / 1e6).toFixed(0)} MB)`);
        const res = await fetch(dl, { headers: { 'User-Agent': 'fable51-worlds-ingest/0.1' } });
        if (!res.ok) { ctx.log?.(`  ${res.status} ${res.statusText}, skipping`); continue; }
        await fs.writeFile(file, Buffer.from(await res.arrayBuffer()));
      }
      tiles.push({ file, title: it.title, publicationDate: it.publicationDate, sourceUrl: dl });
    }
    if (!tiles.length) throw new Error('every LPC tile failed to download');

    // 3. Hand the footprints to the Python worker.
    const rings = (ctx.options?.buildings ?? ctx.buildings ?? [])
      .filter((b) => b.ringGeo?.length >= 4)
      .map((b) => ({ id: b.id, ring: b.ringGeo }));
    if (!rings.length) {
      throw new Error('usgs-lidar-lpc needs building footprints; declare it after osm-overpass');
    }

    const state = (items[0].title.match(/\b([A-Z]{2})_/) ?? [])[1];
    const crs = ctx.options?.crs ?? STATE_PLANE[state] ?? 'EPSG:4326';
    ctx.log?.(`measuring ${rings.length} footprints against ${tiles.length} tile(s) in ${crs}`);

    const payload = JSON.stringify({
      tiles: tiles.map((t) => t.file),
      crs,
      buildings: rings,
      insetM: ctx.options?.insetM ?? 2.5,
      annulusM: ctx.options?.annulusM ?? 25,
      minPoints: ctx.options?.minPoints ?? 30,
    });

    // execFile cannot write stdin, and the payload is far too large for argv, so
    // the request goes via a temp file. laspy holds a whole tile in memory, hence
    // the generous buffer.
    const reqFile = path.join(ctx.cacheDir, 'lidar_req.json');
    await fs.writeFile(reqFile, payload);
    const { stdout } = await exec(
      'bash', ['-c', `python3 ${JSON.stringify(WORKER)} < ${JSON.stringify(reqFile)}`],
      { maxBuffer: 256 * 1024 * 1024 },
    );

    const result = JSON.parse(stdout);
    if (result.error) throw new Error(result.error);
    return {
      raw: { ...result, tileMeta: tiles.map(({ file, ...m }) => m) },
      provenance: { url: TNM, tiles: tiles.length, crs },
    };
  },

  normalize(raw, ctx) {
    const ok = raw.heights.filter((h) => h.heightM != null);
    const skipped = raw.heights.length - ok.length;
    const vintage = raw.tileMeta.map((t) => t.publicationDate).filter(Boolean);
    ctx.log?.(
      `usgs-lidar-lpc: measured ${ok.length}/${raw.heights.length} buildings ` +
        `(${skipped} without enough returns); survey ${vintage.join(', ') || 'unknown'}`,
    );
    return {
      lidarHeights: ok.map((h) => ({ ...h, sourceId: 'usgs-lidar-lpc' })),
      lidarSkipped: raw.heights.filter((h) => h.heightM == null),
      lidarTiles: raw.tileMeta,
    };
  },
};
