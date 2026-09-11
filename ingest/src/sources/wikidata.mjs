/**
 * wikidata — structured cross-checks for landmark dimensions and dates.
 *
 * This adapter exists because of the most interesting result in the whole repo.
 * kyoto-higashiyama's README documents six figures where "the survey won and the
 * popular number lost" — the Yasaka Pagoda is 38.79 m and not the universally
 * repeated 46 m; the Kiyomizu stage deck is at 115.5 m ASL and not 240; the stage
 * pillars are 0.64 m across, not 2 m (that figure is a 周囲/circumference misread as
 * a diameter). Every one of those was caught by a human noticing a contradiction.
 *
 * Wikidata makes half of that check mechanical. It carries P2048 (height), P2043
 * (length), P571 (inception) and P625 (coordinates) as typed quantities with units
 * and per-statement references. Feed those into `reconcile()` alongside the survey
 * figure and a disagreement becomes a row in the uncertainty register instead of a
 * silent wrong number.
 *
 * Verified live on 2026-09-03: a 200 m radius query around the Yasaka Pagoda
 * returns Hōkan-ji (Q11555353) among its neighbours.
 */
import { fetchCached } from '../http.mjs';

const SPARQL = 'https://query.wikidata.org/sparql';

/** Properties worth pulling for a built landmark, with the unit each should be in. */
const PROPS = [
  ['height', 'P2048', 'm'],
  ['length', 'P2043', 'm'],
  ['width', 'P2049', 'm'],
  ['area', 'P2046', 'm2'],
  ['floorsAboveGround', 'P1101', 'count'],
  ['inception', 'P571', 'date'],
  ['heritageDesignation', 'P1435', 'text'],
];

function nearbyQuery({ lat, lon }, radiusKm) {
  const optionals = PROPS.map(([alias, pid]) => `  OPTIONAL { ?item wdt:${pid} ?${alias} . }`).join('\n');
  const vars = PROPS.map(([alias]) => `?${alias}`).join(' ');
  return `SELECT ?item ?itemLabel ?coord ${vars} WHERE {
  SERVICE wikibase:around {
    ?item wdt:P625 ?coord .
    bd:serviceParam wikibase:center "Point(${lon} ${lat})"^^geo:wktLiteral .
    bd:serviceParam wikibase:radius "${radiusKm}" .
  }
${optionals}
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,ja,mul" . }
}`;
}

/** "Point(135.7792488 34.9985564)" -> {lat, lon} */
function parsePoint(wkt) {
  const m = wkt?.match(/Point\(([-\d.]+)\s+([-\d.]+)\)/);
  return m ? { lon: Number(m[1]), lat: Number(m[2]) } : null;
}

export default {
  id: 'wikidata',
  title: 'Wikidata — landmark dimensions, dates and heritage designations',
  license: 'CC0-1.0',
  attribution: 'Wikidata contributors (CC0)',
  homepage: 'https://query.wikidata.org/',
  requires: [],
  provides: ['landmark-facts', 'cross-checks'],

  async fetch(ctx) {
    const { bbox } = ctx.world;
    const centre = { lat: (bbox.north + bbox.south) / 2, lon: (bbox.east + bbox.west) / 2 };
    // Cover the bbox diagonal with a little slack, capped so we do not ask
    // Wikidata for half a prefecture.
    const radiusKm = Math.min(ctx.options?.radiusKm ?? 2, 5);
    const r = await fetchCached(SPARQL, {
      method: 'POST',
      body: `query=${encodeURIComponent(nearbyQuery(centre, radiusKm))}`,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/sparql-results+json',
      },
      cacheDir: ctx.cacheDir, maxAgeMs: ctx.maxAgeMs, refresh: ctx.refresh, timeoutMs: 90_000,
    });
    return { raw: JSON.parse(r.body), provenance: r.provenance };
  },

  normalize(raw, ctx) {
    const { frame, world } = ctx;
    const byQid = new Map();
    for (const b of raw.results?.bindings ?? []) {
      const qid = b.item.value.split('/').pop();
      const geo = parsePoint(b.coord?.value);
      if (!geo || !frame.inBbox(world.bbox, geo.lat, geo.lon, ctx.marginM ?? 200)) continue;
      const rec = byQid.get(qid) ?? {
        qid,
        url: b.item.value,
        label: b.itemLabel?.value ?? null,
        geo,
        facts: {},
      };
      for (const [alias, pid, unit] of PROPS) {
        const v = b[alias]?.value;
        if (v == null || rec.facts[alias]) continue;
        rec.facts[alias] = {
          value: unit === 'date' || unit === 'text' ? v : Number(v),
          unit,
          property: pid,
        };
      }
      byQid.set(qid, rec);
    }
    const landmarks = [...byQid.values()].filter((r) => Object.keys(r.facts).length > 0);
    ctx.log?.(`wikidata: ${byQid.size} entities in bbox, ${landmarks.length} carry usable measurements`);
    return { wikidataLandmarks: landmarks };
  },
};
