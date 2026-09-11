/**
 * usgs-3dep — bare-earth ground elevation for US worlds, from the USGS 3DEP
 * ImageServer.
 *
 * This adapter originally used EPQS, the Elevation Point Query Service, one HTTP
 * request per sample. That is what the Union Square world's committed
 * elevation.json was made with, and at ~200 hand-made queries it was tolerable.
 * It does not survive a real grid. Building the UNC Chapel Hill world needs ~1,020
 * samples, and the measured throughput was 5.9 samples/minute — **2.9 hours** for
 * one world.
 *
 * The cause was not rate limiting. All twelve probe requests returned 200; EPQS
 * simply has a long latency tail (three of twelve took ~9.2 s against a 0.4 s
 * median), and a strictly sequential loop pays that tail on every sample.
 *
 * The ImageServer's `getSamples` operation takes a multipoint geometry and returns
 * every sample in one response, which collapses ~1,020 requests into a handful and
 * removes the tail from the critical path entirely. Values are identical: both
 * endpoints return 144.349411011 m at the Davis Library centroid, and EPQS's
 * 23.940353394 m at the Dewey Monument is reproduced too.
 */
import { fetchCached } from '../http.mjs';

const IMAGE_SERVER =
  'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer';

/**
 * Points per `getSamples` call. The operation is POSTed, so the URL-length ceiling
 * does not apply, but the service does more work per request than it looks and a
 * huge batch is both slower to first byte and more expensive to retry. 250 keeps
 * each response comfortably under a megabyte.
 */
const BATCH = 250;

export default {
  id: 'usgs-3dep',
  title: 'USGS 3DEP bare-earth elevation (ImageServer getSamples)',
  license: 'US-PD',
  attribution: 'U.S. Geological Survey, 3D Elevation Program',
  homepage: 'https://apps.nationalmap.gov/3depdem/',
  requires: [],
  provides: ['elevation'],
  /** Only meaningful inside the United States and its territories. */
  appliesTo: (world) => world.region === 'us',

  async fetch(ctx) {
    const points = samplePoints(ctx.world, ctx.options ?? {});
    const samples = [];
    const failures = [];

    for (let i = 0; i < points.length; i += BATCH) {
      const batch = points.slice(i, i + BATCH);
      const geometry = JSON.stringify({
        points: batch.map((p) => [p.lon, p.lat]),
        spatialReference: { wkid: 4326 },
      });
      const body = new URLSearchParams({
        geometry,
        geometryType: 'esriGeometryMultipoint',
        returnFirstValueOnly: 'true',
        f: 'json',
      }).toString();

      try {
        const r = await fetchCached(`${IMAGE_SERVER}/getSamples`, {
          method: 'POST',
          body,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          cacheDir: ctx.cacheDir,
          maxAgeMs: ctx.maxAgeMs,
          refresh: ctx.refresh,
          timeoutMs: 180_000,
        });
        const json = JSON.parse(r.body);
        if (json.error) throw new Error(json.error.message ?? 'ImageServer error');

        // `locationId` indexes back into the batch we sent. The service omits
        // points that fall outside coverage rather than returning a sentinel, so
        // absence is how "no data" is signalled.
        const seen = new Set();
        for (const s of json.samples ?? []) {
          const src = batch[s.locationId];
          if (!src) continue;
          seen.add(s.locationId);
          const v = Number(s.value);
          if (!Number.isFinite(v) || v < -1000) {
            failures.push({ ...src, reason: `no-data (value=${s.value})` });
            continue;
          }
          samples.push({
            lat: src.lat, lon: src.lon, label: src.label,
            elevationM: Number(v.toFixed(2)),
            ...resolutionOf(s, src.lat),
            datum: 'NAVD88',
          });
        }
        for (let k = 0; k < batch.length; k++) {
          if (!seen.has(k)) failures.push({ ...batch[k], reason: 'outside 3DEP coverage' });
        }
      } catch (err) {
        for (const p of batch) failures.push({ ...p, reason: err.message });
        ctx.log?.(`batch ${i / BATCH + 1} failed: ${err.message}`);
      }
      ctx.log?.(`${samples.length}/${points.length} sampled`);
    }

    if (!samples.length) {
      throw new Error(`usgs-3dep returned no usable samples (${failures.length} failures)`);
    }
    return {
      raw: { samples, failures },
      provenance: { url: `${IMAGE_SERVER}/getSamples`, count: samples.length, requests: Math.ceil(points.length / BATCH) },
    };
  },

  normalize(raw, ctx) {
    const { frame } = ctx;
    const coarse = raw.samples.filter((s) => (s.resolutionM ?? 0) > 5);
    if (coarse.length) {
      ctx.log?.(
        `usgs-3dep: ${coarse.length}/${raw.samples.length} samples come from a raster coarser ` +
          'than 5 m; slope-sensitive geometry there is approximate.',
      );
    }
    return {
      elevations: raw.samples.map((s) => {
        const l = frame.geoToLocal(s.lat, s.lon, s.elevationM);
        return { ...s, local: [Number(l.x.toFixed(2)), Number(l.y.toFixed(2)), Number(l.z.toFixed(2))] };
      }),
      elevationFailures: raw.failures,
    };
  },
};

/**
 * 3DEP reports `resolution` in the units of whichever source raster answered, and
 * those units differ by tile. San Francisco's projected 1 m lidar raster returns
 * `1` (metres); the tile covering UNC Chapel Hill returns `0.0000308641975`, which
 * is 1/9 arc-second in DEGREES. Labelling both `resolutionM` — as this adapter
 * first did — silently reports the Chapel Hill samples as 30-micrometre resolution.
 *
 * Anything below ~0.01 is a degree value; no DEM on earth has centimetre posts.
 * Convert to a ground distance so downstream code can compare samples honestly,
 * and keep the raw figure and its unit alongside.
 */
export function resolutionOf(json, latDeg) {
  const raw = json.resolution;
  if (raw == null || !Number.isFinite(Number(raw))) {
    return { resolutionM: null, resolutionRaw: raw ?? null, resolutionUnit: null };
  }
  const v = Number(raw);
  if (v < 0.01) {
    // Degrees. Use the latitude scale factor; longitude posts are wider apart, so
    // the latitude figure is the conservative (smaller) of the two.
    const mPerDeg = 111_132.954 - 559.822 * Math.cos((2 * latDeg * Math.PI) / 180);
    return { resolutionM: Number((v * mPerDeg).toFixed(2)), resolutionRaw: v, resolutionUnit: 'degrees' };
  }
  return { resolutionM: v, resolutionRaw: v, resolutionUnit: 'metres' };
}

/**
 * A regular lat/lon grid over the bbox, plus any manifest-declared points of
 * interest. `stepM` defaults to 25 m — about 1,020 samples over the UNC campus
 * core, or 1,000 over Union Square's 800x720 m bbox.
 */
export function samplePoints(world, { stepM = 25, extraPoints = [] } = {}) {
  const { bbox } = world;
  const midLat = (bbox.north + bbox.south) / 2;
  const mLat = 111_132.954 - 559.822 * Math.cos((2 * midLat * Math.PI) / 180);
  const mLon = 111_412.84 * Math.cos((midLat * Math.PI) / 180);
  const dLat = stepM / mLat;
  const dLon = stepM / mLon;
  const out = [];
  for (let lat = bbox.south; lat <= bbox.north + 1e-9; lat += dLat) {
    for (let lon = bbox.west; lon <= bbox.east + 1e-9; lon += dLon) {
      out.push({ lat, lon, label: 'grid' });
    }
  }
  for (const p of extraPoints) out.push({ lat: p.lat, lon: p.lon, label: p.label ?? 'poi' });
  return out;
}
