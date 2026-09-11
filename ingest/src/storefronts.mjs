/**
 * storefronts.mjs — merge OSM POIs with Overture places into one storefront
 * registry, keeping the disagreements visible.
 *
 * This is the module aimed squarely at the repo's largest measured gap.
 * union-square-sf/FINAL_QA_REPORT.md lists 33 UNRESOLVED storefronts — bays where
 * the census could not establish a current occupant, several of them on the most
 * visible frontages in the square (384 Post St, the former Saks; 225 Post St, the
 * former Burberry; 200 Stockton St, the former Bulgari). The report is honest about
 * them, which is right, but they render as blank fascias.
 *
 * Two independent corpora agreeing on a name is much stronger evidence than either
 * alone, and Overture's places theme draws on Meta's and Microsoft's POI data in
 * addition to OSM — so it sees churn that OSM has not caught up with. The rules
 * below are deliberately conservative, because the brief is explicit: "Do not
 * hallucinate a famous brand into an unknown location."
 */

/** Haversine distance in metres — the matching radius is ~20 m, so this must be exact. */
function haversineM(a, b) {
  const R = 6_371_008.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Normalise a trading name for comparison: "Apple Union Square" ~ "Apple, Union Square". */
function normName(s) {
  return (s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\b(the|inc|llc|ltd|co|store|shop)\b/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Do two names refer to the same business? Substring containment catches brand+branch. */
function namesAgree(a, b) {
  const x = normName(a), y = normName(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

const RANK = { high: 3, medium: 2, low: 1 };

/**
 * @param {object} args
 * @param {Array} args.osmPois          from the osm-overpass adapter
 * @param {Array} args.overturePlaces   from the overture adapter
 * @param {number} args.radiusM         how close two records must be to be the same shop
 * @returns {Array} storefront registry records
 */
export function reconcileStorefronts({ osmPois = [], overturePlaces = [], radiusM = 20 }) {
  const out = [];
  const usedOverture = new Set();

  for (const poi of osmPois) {
    // Nearest Overture place with a compatible name wins; a nearby place with a
    // *contradictory* name is recorded as a conflict, never silently preferred.
    let best = null;
    let contradiction = null;
    for (const pl of overturePlaces) {
      if (usedOverture.has(pl.id)) continue;
      const d = haversineM(poi.geo, pl.geo);
      if (d > radiusM) continue;
      const label = pl.brand ?? pl.name;
      if (namesAgree(poi.name ?? poi.brand, label)) {
        if (!best || d < best.d) best = { pl, d };
      } else if (poi.name && label && (!contradiction || d < contradiction.d)) {
        contradiction = { pl, d };
      }
    }

    if (best) usedOverture.add(best.pl.id);

    const sources = ['osm-overpass', ...(best ? ['overture'] : [])];
    // Corroboration is the only thing that promotes a record to high confidence.
    const confidence = best
      ? (RANK[best.pl.confidence] >= 2 ? 'high' : 'medium')
      : poi.name ? 'medium' : 'low';

    out.push({
      id: poi.id,
      name: poi.name ?? best?.pl.name ?? null,
      brand: poi.brand ?? best?.pl.brand ?? null,
      brandWikidata: best?.pl.brandWikidata ?? poi.tags?.['brand:wikidata'] ?? null,
      category: poi.category ?? best?.pl.category ?? null,
      address: poi.address ?? best?.pl.address ?? null,
      website: best?.pl.website ?? poi.tags?.website ?? null,
      pos: poi.pos,
      geo: poi.geo,
      confidence,
      sources,
      corroboration: best ? { overtureId: best.pl.id, distanceM: Number(best.d.toFixed(1)) } : null,
      conflict: contradiction
        ? {
            overtureId: contradiction.pl.id,
            overtureName: contradiction.pl.brand ?? contradiction.pl.name,
            distanceM: Number(contradiction.d.toFixed(1)),
            note: 'two corpora name different businesses at this location — verify before rendering signage',
          }
        : null,
      status: 'resolved',
    });
  }

  /*
   * Overture places with no OSM counterpart. These are the interesting ones: they
   * are candidates for the bays FINAL_QA_REPORT.md lists as UNRESOLVED. They are
   * emitted as `status: 'candidate'`, NOT as resolved storefronts, so the renderer
   * keeps showing a neutral fascia until a human or a QA agent confirms them.
   * Anything below Overture's own medium-confidence cut is dropped outright.
   */
  for (const pl of overturePlaces) {
    if (usedOverture.has(pl.id)) continue;
    if (RANK[pl.confidence] < 2) continue;
    out.push({
      id: pl.id,
      name: pl.name,
      brand: pl.brand ?? null,
      brandWikidata: pl.brandWikidata ?? null,
      category: pl.category ?? null,
      address: pl.address ?? null,
      website: pl.website ?? null,
      pos: pl.pos,
      geo: pl.geo,
      confidence: pl.confidence,
      confidenceRaw: pl.confidenceRaw ?? null,
      sources: ['overture'],
      corroboration: null,
      conflict: null,
      status: 'candidate',
    });
  }

  return out;
}

/** Summary counts for the build log and FINAL_QA_REPORT. */
export function summarise(storefronts) {
  const by = (pred) => storefronts.filter(pred).length;
  return {
    total: storefronts.length,
    resolved: by((s) => s.status === 'resolved'),
    candidates: by((s) => s.status === 'candidate'),
    corroborated: by((s) => s.sources.length > 1),
    conflicts: by((s) => s.conflict),
    high: by((s) => s.confidence === 'high'),
    medium: by((s) => s.confidence === 'medium'),
    low: by((s) => s.confidence === 'low'),
  };
}
