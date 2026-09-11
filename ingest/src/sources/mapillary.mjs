/**
 * mapillary — crowd-sourced street-level imagery, as a legitimate substitute for
 * the one reference source both worlds are explicitly forbidden from shipping.
 *
 * union-square-sf/PROMPT.md draws the line clearly: "Treat Google Earth as a
 * ground-truth visual reference, not as an asset package... Do not extract,
 * redistribute, or ship proprietary Google Earth 3D meshes or textures." That is
 * the right rule, and it leaves the repo with no street-level imagery it may
 * actually keep.
 *
 * Mapillary is that missing piece. Its images are CC-BY-SA 4.0, the API exposes
 * each image's exact position and `compass_angle`, and — the part that matters for
 * a storefront census — Mapillary runs its own detection layer, so you can query
 * for `object--sign--store` and `object--street-light` rather than eyeballing.
 *
 * Requires a free access token (MAPILLARY_TOKEN). Every other adapter in this
 * package is keyless; this one is opt-in and the pipeline skips it cleanly when the
 * token is absent.
 */
import { fetchJson } from '../http.mjs';

const API = 'https://graph.mapillary.com/images';

export default {
  id: 'mapillary',
  title: 'Mapillary — street-level imagery and detections',
  license: 'CC-BY-SA-4.0',
  attribution: '© Mapillary contributors, CC BY-SA 4.0',
  homepage: 'https://www.mapillary.com/developer/api-documentation',
  requires: ['MAPILLARY_TOKEN'],
  provides: ['street-level-imagery', 'sign-detections'],

  /** Skipped rather than failed when unconfigured — see pipeline.mjs. */
  available: () => Boolean(process.env.MAPILLARY_TOKEN),

  async fetch(ctx) {
    const token = process.env.MAPILLARY_TOKEN;
    if (!token) throw new Error('mapillary: MAPILLARY_TOKEN is not set');
    const { bbox } = ctx.world;
    const fields = [
      'id', 'computed_geometry', 'compass_angle', 'computed_compass_angle',
      'captured_at', 'is_pano', 'thumb_2048_url', 'creator',
    ].join(',');
    const limit = Math.min(ctx.options?.limit ?? 500, 2000);
    const url =
      `${API}?fields=${fields}` +
      `&bbox=${bbox.west},${bbox.south},${bbox.east},${bbox.north}` +
      `&limit=${limit}`;
    const { json, provenance } = await fetchJson(url, {
      headers: { Authorization: `OAuth ${token}` },
      cacheDir: ctx.cacheDir, maxAgeMs: ctx.maxAgeMs, refresh: ctx.refresh, timeoutMs: 90_000,
    });
    // Never let a bearer token reach the provenance sidecar that gets committed.
    return { raw: json, provenance: { ...provenance, url: url.replace(/OAuth [^&]*/, 'OAuth <redacted>') } };
  },

  normalize(raw, ctx) {
    const { frame, world } = ctx;
    const r2 = (v) => Math.round(v * 100) / 100;
    const images = [];
    for (const im of raw.data ?? []) {
      const c = im.computed_geometry?.coordinates;
      if (!c) continue;
      const [lon, lat] = c;
      if (!frame.inBbox(world.bbox, lat, lon)) continue;
      const l = frame.geoToLocal(lat, lon);
      images.push({
        id: `mapillary/${im.id}`,
        pos: [r2(l.x), r2(l.z)],
        geo: { lat, lon },
        // computed_compass_angle is the SfM-refined heading; prefer it over the
        // raw device compass, which is routinely tens of degrees out.
        headingDeg: im.computed_compass_angle ?? im.compass_angle ?? null,
        capturedAt: im.captured_at ? new Date(im.captured_at).toISOString() : null,
        panorama: Boolean(im.is_pano),
        thumbUrl: im.thumb_2048_url ?? null,
        creator: im.creator?.username ?? null,
      });
    }
    ctx.log?.(`mapillary: ${images.length} street-level images in bbox`);
    return { streetImagery: images };
  },
};
