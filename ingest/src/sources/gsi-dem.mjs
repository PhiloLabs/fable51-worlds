/**
 * gsi-dem — bare-earth ground elevation for Japanese worlds, from the Geospatial
 * Information Authority of Japan's 1 m airborne-lidar DEM.
 *
 * kyoto-higashiyama's README says "every elevation is an independent point query
 * against the GSI 1 m airborne-LiDAR bare-earth DEM — about 200 of them". Those
 * 200 queries were made by hand and only their results were committed. This is the
 * script that makes them, so the 76 m climb from Hanamikoji to the Kiyomizu stage
 * can be re-derived rather than trusted.
 *
 * GSI's getelevation endpoint reports which source layer answered
 * (`DEM1A`/`DEM5A` = lidar, `DEM10B` = photogrammetric contours). That distinction
 * matters on a hillside: DEM10B carries several metres of error, which is enough to
 * put the Kiyomizu stage deck at the wrong height.
 */
import { fetchJson } from '../http.mjs';
import { samplePoints } from './usgs-3dep.mjs';

const ENDPOINT = 'https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php';

/**
 * `hsrc` is a human-readable Japanese layer label, not a DEM code — the live
 * endpoint answers `{"elevation":61.3,"hsrc":"1m（レーザ）"}` at the Yasaka Pagoda.
 * レーザ ("laser") marks the airborne-lidar layers; 写真測量 / 地形図等高線 mark the
 * photogrammetric and contour-derived ones, which carry metre-scale error and must
 * not be trusted on a hillside.
 */
const LIDAR_LABEL = /レーザ/;

export default {
  id: 'gsi-dem',
  title: 'GSI (Japan) elevation — 1 m / 5 m airborne-lidar bare-earth DEM',
  license: 'JP-GOV-2.0',
  attribution: '国土地理院 (Geospatial Information Authority of Japan)',
  homepage: 'https://maps.gsi.go.jp/development/elevation_s.html',
  requires: [],
  provides: ['elevation'],
  appliesTo: (world) => world.region === 'jp',

  async fetch(ctx) {
    const points = samplePoints(ctx.world, ctx.options ?? {});
    const samples = [];
    const failures = [];
    for (const p of points) {
      const url = `${ENDPOINT}?lon=${p.lon.toFixed(7)}&lat=${p.lat.toFixed(7)}&outtype=JSON`;
      try {
        const { json } = await fetchJson(url, {
          cacheDir: ctx.cacheDir,
          maxAgeMs: ctx.maxAgeMs,
          refresh: ctx.refresh,
          timeoutMs: 30_000,
        });
        // Outside coverage GSI answers with the string "-----", not an error.
        const v = Number(json.elevation);
        if (!Number.isFinite(v)) {
          failures.push({ ...p, reason: `no-data (elevation=${json.elevation})` });
          continue;
        }
        samples.push({
          lat: p.lat, lon: p.lon, label: p.label,
          elevationM: Number(v.toFixed(2)),
          layer: json.hsrc ?? null,
          lidar: LIDAR_LABEL.test(json.hsrc ?? ''),
          datum: 'T.P. (Tokyo Peil)',
        });
      } catch (err) {
        failures.push({ ...p, reason: err.message });
      }
      ctx.progress?.(samples.length + failures.length, points.length);
    }
    if (!samples.length) throw new Error(`gsi-dem returned no usable samples (${failures.length} failures)`);
    return { raw: { samples, failures }, provenance: { url: ENDPOINT, count: samples.length } };
  },

  normalize(raw, ctx) {
    const { frame } = ctx;
    const nonLidar = raw.samples.filter((s) => !s.lidar);
    if (nonLidar.length) {
      ctx.log?.(
        `gsi-dem: ${nonLidar.length}/${raw.samples.length} samples came from a non-lidar layer ` +
          `(${[...new Set(nonLidar.map((s) => s.layer))].join(', ')}); these carry metre-scale error.`,
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
