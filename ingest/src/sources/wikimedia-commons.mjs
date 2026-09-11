/**
 * wikimedia-commons — free-licensed reference photographs near each camera-match
 * viewpoint.
 *
 * union-square-sf validates itself by screenshotting 34 fixed viewpoints and
 * diffing them against "free-licensed photographs taken from the same spot", with
 * provenance recorded by hand in refs/<sector>/SOURCES.md and the images themselves
 * gitignored (`refs/**\/*.jpg`). That means a fresh clone cannot run the comparison
 * pass at all — the QA harness's ground truth is missing.
 *
 * Commons geosearch fixes that: given a viewpoint's lat/lon it returns georeferenced
 * images with their licence, author and camera heading, all machine-readable. The
 * repo then stores the *manifest* (stable file names, licences, authors, URLs)
 * rather than the pixels, and `ingest refs` re-downloads them into the gitignored
 * refs/ tree on demand. Ground truth becomes reproducible without redistributing a
 * single photograph.
 */
import { fetchJson } from '../http.mjs';

const API = 'https://commons.wikimedia.org/w/api.php';

/** Licences we are willing to use as camera-match ground truth. */
const ACCEPTABLE = /^(cc0|cc[- ]by([- ]sa)?[- ]?\d|public domain|pd-)/i;

export default {
  id: 'wikimedia-commons',
  title: 'Wikimedia Commons — georeferenced reference photography',
  license: 'CC-BY-SA-4.0',
  attribution: 'Wikimedia Commons contributors; per-image licence recorded in the manifest',
  homepage: 'https://commons.wikimedia.org/wiki/Commons:Geocoding',
  requires: [],
  provides: ['reference-images'],

  async fetch(ctx) {
    const viewpoints = ctx.options?.viewpoints ?? [];
    if (!viewpoints.length) {
      // Fall back to the bbox centre so the adapter is still useful before any
      // viewpoints have been authored.
      const { bbox } = ctx.world;
      viewpoints.push({
        id: 'bbox-centre',
        lat: (bbox.north + bbox.south) / 2,
        lon: (bbox.east + bbox.west) / 2,
      });
    }
    const radiusM = Math.min(ctx.options?.radiusM ?? 250, 10_000); // API hard-caps at 10 km
    const perViewpoint = ctx.options?.limit ?? 30;

    const results = [];
    for (const vp of viewpoints) {
      const url =
        `${API}?action=query&format=json&formatversion=2` +
        `&generator=geosearch&ggscoord=${vp.lat}%7C${vp.lon}&ggsradius=${radiusM}` +
        `&ggslimit=${perViewpoint}&ggsnamespace=6` +
        `&prop=imageinfo&iiprop=url%7Cextmetadata%7Csize` +
        `&iiextmetadatafilter=LicenseShortName%7CArtist%7CLicenseUrl%7CDateTimeOriginal%7CGPSImgDirection`;
      try {
        const { json } = await fetchJson(url, {
          cacheDir: ctx.cacheDir, maxAgeMs: ctx.maxAgeMs, refresh: ctx.refresh, timeoutMs: 45_000,
        });
        results.push({ viewpoint: vp, pages: json.query?.pages ?? [] });
      } catch (err) {
        ctx.log?.(`wikimedia-commons: viewpoint ${vp.id} failed: ${err.message}`);
        results.push({ viewpoint: vp, pages: [], error: err.message });
      }
    }
    return { raw: { results, radiusM }, provenance: { url: API, viewpoints: viewpoints.length } };
  },

  normalize(raw, ctx) {
    const refs = [];
    let rejected = 0;
    for (const { viewpoint, pages } of raw.results) {
      for (const page of pages) {
        const info = page.imageinfo?.[0];
        if (!info) continue;
        const meta = info.extmetadata ?? {};
        const licence = meta.LicenseShortName?.value ?? '';
        // Strip the HTML Commons wraps around author fields.
        const author = (meta.Artist?.value ?? '').replace(/<[^>]+>/g, '').trim() || null;
        if (!ACCEPTABLE.test(licence)) { rejected++; continue; }
        refs.push({
          viewpointId: viewpoint.id,
          title: page.title,
          file: page.title.replace(/^File:/, ''),
          url: info.url,
          descriptionUrl: info.descriptionurl,
          width: info.width ?? null,
          height: info.height ?? null,
          licence,
          licenceUrl: meta.LicenseUrl?.value ?? null,
          author,
          takenOn: meta.DateTimeOriginal?.value?.replace(/<[^>]+>/g, '') ?? null,
          // Compass heading in degrees, when the photographer's camera recorded it.
          // A reference whose heading matches the viewpoint's is the strongest
          // possible camera-match candidate.
          headingDeg: meta.GPSImgDirection?.value ? Number(meta.GPSImgDirection.value) : null,
        });
      }
    }
    ctx.log?.(`wikimedia-commons: ${refs.length} usable references (${rejected} rejected on licence)`);
    return { referenceImages: refs };
  },
};
