/**
 * buildings.mjs — merge building footprints across sources and refuse to ship a
 * height nobody corroborated.
 *
 * This module exists because of a concrete near-miss. Building the UNC Chapel Hill
 * world, OSM way 44343213 (Walter Royal Davis Library) carries neither `height` nor
 * `building:levels`, so the baseline had nothing to extrude. Overture supplied a
 * height for the identical footprint — 11.73 m. Davis Library has eight floors
 * above ground, which puts that at 1.47 m per storey: wrong by about 2.5x, on the
 * single most important building in the world.
 *
 * Nothing in the pipeline caught it. `storefronts.mjs` already refuses to promote
 * an uncorroborated business name, but heights were being passed straight through
 * on a single source's say-so. That asymmetry was the bug — a wrong height on the
 * subject of the reconstruction is worse than a wrong shop name on a side street.
 *
 * So: the same discipline, applied to geometry. A height with one source is
 * `single-source` and carries a warning. Two sources that disagree produce a
 * conflict rather than a silent winner. A height that implies an impossible storey
 * height is rejected outright.
 */
import { reconcile } from './provenance.mjs';

/**
 * Plausible metres per storey. Below 2.2 m nobody can stand up; above 6 m you are
 * looking at a hall, an atrium or a mis-parsed figure. Deliberately wide — this is
 * a gate against nonsense, not a style guide.
 */
const MIN_STOREY_M = 2.2;
const MAX_STOREY_M = 6.0;

/** Shoelace area of a closed [[x,z],...] ring, m². */
export function footprintArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return Math.abs(a / 2);
}

/**
 * Is this height physically possible for a building with this many storeys?
 * Returns null when we cannot tell (no storey count known).
 */
export function storeyCheck(heightM, levels) {
  if (heightM == null || !levels) return null;
  const perStorey = heightM / levels;
  if (perStorey < MIN_STOREY_M) {
    return { ok: false, perStorey, reason: `${perStorey.toFixed(2)} m per storey is below the ${MIN_STOREY_M} m floor` };
  }
  if (perStorey > MAX_STOREY_M) {
    return { ok: false, perStorey, reason: `${perStorey.toFixed(2)} m per storey exceeds the ${MAX_STOREY_M} m ceiling` };
  }
  return { ok: true, perStorey };
}

/** Match buildings across sources by footprint area and centroid proximity. */
function centroid(ring) {
  let x = 0, z = 0;
  for (let i = 0; i < ring.length - 1; i++) { x += ring[i][0]; z += ring[i][1]; }
  const n = ring.length - 1;
  return [x / n, z / n];
}

/**
 * @param {object} args
 * @param {Array} args.osmBuildings       from osm-overpass
 * @param {Array} args.overtureBuildings  from overture
 * @param {number} [args.areaTolerance=0.15]  relative footprint-area agreement
 * @param {number} [args.centroidToleranceM=15]
 */
export function reconcileBuildings({
  osmBuildings = [], overtureBuildings = [], lidarHeights = [],
  areaTolerance = 0.15, centroidToleranceM = 15,
}) {
  const lidarById = new Map(lidarHeights.map((h) => [h.id, h]));
  const ovt = overtureBuildings.map((b) => ({
    b, area: footprintArea(b.footprint), c: centroid(b.footprint), used: false,
  }));

  const out = [];
  const warnings = [];

  for (const osm of osmBuildings) {
    const area = footprintArea(osm.footprint);
    const c = centroid(osm.footprint);

    let match = null;
    for (const cand of ovt) {
      if (cand.used) continue;
      const dist = Math.hypot(cand.c[0] - c[0], cand.c[1] - c[1]);
      if (dist > centroidToleranceM) continue;
      const areaRel = Math.abs(cand.area - area) / (area || 1);
      if (areaRel > areaTolerance) continue;
      if (!match || dist < match.dist) match = { cand, dist, areaRel };
    }
    if (match) match.cand.used = true;

    const levels = osm.levels ?? match?.cand.b.levels ?? null;

    // Collect every height anyone offers, with its source and confidence.
    const heights = [];
    if (osm.heightM != null) {
      heights.push({
        value: osm.heightM, unit: 'm', sourceId: 'osm-overpass', license: 'ODbL-1.0',
        confidence: osm.heightSource === 'osm:height' ? 'high' : 'medium',
        note: osm.heightSource, fetchedUtc: new Date().toISOString(),
      });
    }
    if (match?.cand.b.heightM != null) {
      heights.push({
        value: match.cand.b.heightM, unit: 'm', sourceId: 'overture', license: 'ODbL-1.0',
        confidence: 'medium', fetchedUtc: new Date().toISOString(),
      });
    }
    // A lidar measurement outranks every estimate. OSM's height tag is
    // hand-entered and Overture's is model-derived; this one is the roof plane
    // minus the ground, from returns that actually hit the building. Only a
    // thinly-sampled roof (<120 returns) drops to parity with the estimates.
    const lidar = lidarById.get(osm.id);
    if (lidar?.heightM != null) {
      heights.push({
        value: lidar.heightM, unit: 'm', sourceId: 'usgs-lidar-lpc', license: 'US-PD',
        confidence: lidar.confidence === 'low' ? 'medium' : 'high',
        note: `${lidar.points} roof returns; roof ${lidar.roofM} m, ground ${lidar.groundM} m`,
        fetchedUtc: new Date().toISOString(),
      });
    }

    let heightM = null, heightConfidence = 'none', conflicts = [], rejected = [];

    if (heights.length) {
      // Reject anything physically impossible BEFORE reconciling, so a nonsense
      // value cannot win by having the higher nominal confidence.
      const viable = [];
      for (const h of heights) {
        // The storey gate exists to catch estimates that imply an impossible
        // floor height. A lidar measurement is not an estimate — if it disagrees
        // with a levels tag, the tag is the suspect party — so it is exempt, and
        // the disagreement surfaces as a conflict instead.
        const chk = h.sourceId === 'usgs-lidar-lpc' ? null : storeyCheck(h.value, levels);
        if (chk && !chk.ok) {
          rejected.push({ ...h, reason: chk.reason });
          warnings.push({
            id: osm.id, name: osm.name ?? null, kind: 'implausible-height',
            value: h.value, levels, sourceId: h.sourceId, reason: chk.reason,
          });
        } else viable.push(h);
      }
      if (viable.length) {
        const r = reconcile(viable, { toleranceRel: 0.15 });
        heightM = r.chosen.value;
        conflicts = r.conflicts;
        heightConfidence = viable.length > 1
          ? (r.conflicts.length ? 'disputed' : 'corroborated')
          : 'single-source';
        if (heightConfidence === 'single-source') {
          warnings.push({
            id: osm.id, name: osm.name ?? null, kind: 'uncorroborated-height',
            value: heightM, sourceId: viable[0].sourceId,
            reason: 'only one source offers a height; no second opinion to check it against',
          });
        }
        if (r.conflicts.length) {
          warnings.push({
            id: osm.id, name: osm.name ?? null, kind: 'disputed-height',
            value: heightM, sourceId: r.chosen.sourceId,
            reason: r.conflicts.map((c) => `${c.rejected.sourceId} says ${c.rejected.value} m`).join('; '),
          });
        }
      }
    }

    out.push({
      ...osm,
      area: Number(area.toFixed(1)),
      levels,
      heightM,
      heightConfidence,
      heightSources: heights.map((h) => h.sourceId),
      heightRejected: rejected.length ? rejected : null,
      heightConflicts: conflicts.length
        ? conflicts.map((c) => ({ sourceId: c.rejected.sourceId, value: c.rejected.value, deltaRel: Number(c.deltaRel.toFixed(3)) }))
        : null,
      roofShape: match?.cand.b.roofShape ?? null,
      lidar: lidarById.get(osm.id) ?? null,
      overtureId: match?.cand.b.id ?? null,
    });
  }

  // Overture footprints with no OSM counterpart — real buildings OSM has not
  // mapped. Kept, but marked, because nothing corroborates their geometry either.
  for (const cand of ovt) {
    if (cand.used) continue;
    out.push({
      ...cand.b,
      area: Number(cand.area.toFixed(1)),
      heightConfidence: cand.b.heightM != null ? 'single-source' : 'none',
      heightSources: cand.b.heightM != null ? ['overture'] : [],
      heightRejected: null,
      heightConflicts: null,
      unmatched: true,
    });
  }

  return { buildings: out, warnings };
}

/** Counts for the build log and the QA report. */
export function summariseBuildings(buildings) {
  const by = (p) => buildings.filter(p).length;
  return {
    total: buildings.length,
    withHeight: by((b) => b.heightM != null),
    corroborated: by((b) => b.heightConfidence === 'corroborated'),
    singleSource: by((b) => b.heightConfidence === 'single-source'),
    disputed: by((b) => b.heightConfidence === 'disputed'),
    rejected: by((b) => b.heightRejected),
    noHeight: by((b) => b.heightM == null),
  };
}
