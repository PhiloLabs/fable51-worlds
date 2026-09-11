/**
 * plateau — Japan's national 3D city models (国土交通省 Project PLATEAU).
 *
 * For kyoto-higashiyama this is the single largest available accuracy upgrade, and
 * the repo does not use it. The world today is built from OSM footprints plus ~200
 * GSI elevation point queries, with every roof, eave and storey count authored by
 * hand from cultural-property records. PLATEAU publishes, for Kyoto specifically,
 * an LOD2 building model (real roof geometry, not extruded footprints) with
 * per-building 用途 (usage) and 建築年 (year of construction) attributes — and, in
 * the FY2025 release, LOD3.3 for the model districts.
 *
 * Verified live against the CKAN catalogue on 2026-09-03:
 *   plateau-26100-kyoto-shi-2025 → 6 resources incl. "CityGML（v5）" and
 *   "3D Tiles, MVT（v5）"; licence "PLATEAU Site Policy" (政府標準利用規約 2.0,
 *   CC-BY-4.0 compatible, commercial use permitted).
 *
 * SCOPE NOTE: this adapter resolves the catalogue, records the resource manifest,
 * and parses building attributes and LOD0 roof-edge footprints out of CityGML.
 * Lifting the full LOD2 solids into GLB kit pieces is a larger job and is NOT done
 * here — see docs/INGEST.md, "What PLATEAU does not yet give us".
 */
import { fetchCached, fetchJson } from '../http.mjs';

const CKAN = 'https://www.geospatial.jp/ckan/api/3/action/package_show';

/**
 * PLATEAU dataset ids are `plateau-<JIS municipality code>-<romaji>-<fiscal year>`.
 * 26100 is Kyoto City; 13100 Tokyo 23 wards; 27100 Osaka City.
 */
export const DATASETS = {
  'kyoto-shi': { code: '26100', latest: 'plateau-26100-kyoto-shi-2025' },
  'tokyo-23ku': { code: '13100', latest: 'plateau-13100-tokyo-23ku-2023' },
  'osaka-shi': { code: '27100', latest: 'plateau-27100-osaka-shi-2023' },
};

export default {
  id: 'plateau',
  title: 'Project PLATEAU — national 3D city models of Japan (LOD1/LOD2 CityGML)',
  license: 'JP-GOV-2.0',
  attribution: '国土交通省 Project PLATEAU (MLIT Japan)',
  homepage: 'https://www.mlit.go.jp/plateau/',
  requires: [],
  provides: ['buildings', 'roof-geometry', 'building-usage', 'year-built'],
  appliesTo: (world) => world.region === 'jp',

  async fetch(ctx) {
    const datasetId = ctx.options?.dataset ?? DATASETS[ctx.options?.municipality ?? 'kyoto-shi']?.latest;
    if (!datasetId) {
      throw new Error(
        'plateau: set `options.dataset` (a geospatial.jp CKAN id) or `options.municipality` ' +
          `(one of ${Object.keys(DATASETS).join(', ')}) in the world manifest.`,
      );
    }
    const { json } = await fetchJson(`${CKAN}?id=${encodeURIComponent(datasetId)}`, {
      cacheDir: ctx.cacheDir, maxAgeMs: ctx.maxAgeMs, refresh: ctx.refresh, timeoutMs: 60_000,
    });
    if (!json.success) throw new Error(`plateau: CKAN lookup failed for ${datasetId}`);
    const pkg = json.result;

    const resources = (pkg.resources ?? [])
      .filter((r) => r.url)
      .map((r) => ({
        name: r.name, format: r.format, url: r.url,
        bytes: r.size ?? null, lastModified: r.last_modified ?? null,
      }));

    // The CityGML bundle is a multi-hundred-megabyte zip. Pull it only when the
    // manifest explicitly asks, so `ingest fetch` stays cheap by default.
    let citygml = null;
    if (ctx.options?.downloadCityGml) {
      const res = resources.find((r) => /CityGML/i.test(r.name));
      if (!res) throw new Error(`plateau: no CityGML resource in ${datasetId}`);
      ctx.log?.(`plateau: downloading CityGML bundle (${res.bytes ?? '?'} bytes) — this is large`);
      const r = await fetchCached(res.url, {
        cacheDir: ctx.cacheDir, maxAgeMs: ctx.maxAgeMs, refresh: ctx.refresh, timeoutMs: 900_000,
      });
      citygml = { resource: res, sha256: r.provenance.responseSha256, bytes: r.provenance.bytes };
    }

    return {
      raw: {
        datasetId,
        title: pkg.title,
        licenseTitle: pkg.license_title ?? null,
        metadataModified: pkg.metadata_modified ?? null,
        resources,
        citygml,
      },
      provenance: { url: `${CKAN}?id=${datasetId}`, datasetId },
    };
  },

  normalize(raw, ctx) {
    // Until the CityGML solids are lifted, what this source contributes is a
    // machine-readable, licence-checked record of exactly which official release a
    // world was built against — which is what makes "the pagoda is 38.79 m" auditable.
    ctx.log?.(
      `plateau: ${raw.datasetId} — ${raw.resources.length} resources ` +
        `(${raw.resources.map((r) => r.format).join(', ')})`,
    );
    return {
      plateau: {
        datasetId: raw.datasetId,
        title: raw.title,
        licenseTitle: raw.licenseTitle,
        metadataModified: raw.metadataModified,
        resources: raw.resources,
        citygml: raw.citygml,
      },
    };
  },
};

/**
 * Parse the building records out of one PLATEAU CityGML file.
 *
 * Exported separately from the adapter so the asset-generation stage can stream a
 * multi-gigabyte bundle without holding it in memory. Reads the LOD0 roof edge (the
 * true roof outline, which is what you want for a footprint — PLATEAU's LOD0 is the
 * roof projection, not the wall line) plus the attributes OSM does not carry.
 *
 * @param {string} gml  the contents of one `*_bldg_*.gml`
 */
export function parseCityGmlBuildings(gml) {
  const out = [];
  // CityGML is namespaced XML; a regex scan is adequate here because PLATEAU emits
  // a rigid, machine-generated shape and we only need five leaf values per building.
  const buildings = gml.split(/<(?:bldg:)?Building\b/).slice(1);
  for (const chunk of buildings) {
    const id = chunk.match(/gml:id="([^"]+)"/)?.[1] ?? null;
    const height = Number(chunk.match(/<bldg:measuredHeight[^>]*>([\d.]+)</)?.[1] ?? NaN);
    const storeys = Number(chunk.match(/<bldg:storeysAboveGround>(\d+)</)?.[1] ?? NaN);
    const usage = chunk.match(/<bldg:usage[^>]*>([^<]+)</)?.[1] ?? null;
    const year = Number(chunk.match(/<bldg:yearOfConstruction>(\d+)</)?.[1] ?? NaN);
    const posList = chunk.match(/<bldg:lod0RoofEdge>[\s\S]*?<gml:posList[^>]*>([\s\S]*?)<\/gml:posList>/)?.[1];
    let ring = null;
    if (posList) {
      const n = posList.trim().split(/\s+/).map(Number);
      // PLATEAU posLists are lat lon height triples in JGD2011 geographic coords.
      ring = [];
      for (let i = 0; i + 2 < n.length; i += 3) ring.push({ lat: n[i], lon: n[i + 1], z: n[i + 2] });
    }
    out.push({
      id,
      measuredHeightM: Number.isFinite(height) ? height : null,
      storeysAboveGround: Number.isFinite(storeys) ? storeys : null,
      usageCode: usage,
      yearOfConstruction: Number.isFinite(year) ? year : null,
      lod0RoofEdge: ring,
    });
  }
  return out;
}
