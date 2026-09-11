/**
 * Unit tests for the parts of the ingest pipeline that must not silently drift:
 * the projection, the licence gate, measurement reconciliation, the storefront
 * merge, and the GTFS CSV reader.
 *
 * Deliberately offline — no test here touches the network. The live adapters are
 * exercised by `ingest fetch`, which CI runs separately and is allowed to fail on
 * upstream outage; these must always pass.
 *
 * Run: node --test ingest/test/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrame, metresPerDegree, emitRuntimeModule } from '../src/geo.mjs';
import { reconcile, fact } from '../src/provenance.mjs';
import { verify } from '../src/pipeline.mjs';
import { reconcileStorefronts, summarise } from '../src/storefronts.mjs';
import { reconcileBuildings, storeyCheck } from '../src/buildings.mjs';
import { parseCsv } from '../src/sources/gtfs.mjs';
import { resolutionOf } from '../src/sources/usgs-3dep.mjs';
import { LICENSES, assertKnownLicense } from '../src/licenses.mjs';
import { ADAPTERS } from '../src/sources/index.mjs';

/* ------------------------------------------------------------------ geodesy */

test('metresPerDegree matches the constants the existing worlds were built on', () => {
  // union-square-sf/src/geo/geo.ts states these for LAT0 = 37.788.
  const sf = metresPerDegree(37.788);
  assert.equal(Number(sf.lat.toFixed(3)), 110992.476);
  assert.equal(Number(sf.lon.toFixed(3)), 88084.677);
});

test('geoToLocal and localToGeo are exact inverses under a rotated grid', () => {
  const frame = createFrame({
    originLat: 37.787935, originLon: -122.40752, originElevationM: 23.94, gridBearingDeg: 80.686, lat0Deg: 37.788,
  });
  for (const [lat, lon] of [[37.7890, -122.4060], [37.7860, -122.4100], [37.7905, -122.4040]]) {
    const l = frame.geoToLocal(lat, lon);
    const back = frame.localToGeo(l.x, l.z);
    assert.ok(Math.abs(back.lat - lat) < 1e-9, `lat round-trip drifted: ${back.lat} vs ${lat}`);
    assert.ok(Math.abs(back.lon - lon) < 1e-9, `lon round-trip drifted: ${back.lon} vs ${lon}`);
  }
});

test('the origin maps to the local origin, and y is relative to origin elevation', () => {
  const frame = createFrame({ originLat: 35, originLon: 135, originElevationM: 61.3, gridBearingDeg: 90 });
  const o = frame.geoToLocal(35, 135, 61.3);
  assert.ok(Math.abs(o.x) < 1e-6 && Math.abs(o.y) < 1e-6 && Math.abs(o.z) < 1e-6);
  const up = frame.geoToLocal(35, 135, 100);
  assert.equal(Number(up.y.toFixed(2)), 38.7);
});

test('a bearing-90 frame puts +x due east and +z due south', () => {
  const frame = createFrame({ originLat: 35, originLon: 135, gridBearingDeg: 90 });
  const east = frame.geoToLocal(35, 135.001);
  const north = frame.geoToLocal(35.001, 135);
  assert.ok(east.x > 0 && Math.abs(east.z) < 1e-6, 'east should be +x only');
  assert.ok(north.z < 0 && Math.abs(north.x) < 1e-6, 'north should be -z only');
});

test('emitRuntimeModule reproduces the committed geo.ts constants verbatim', () => {
  const src = emitRuntimeModule({
    id: 'union-square-sf',
    bbox: { south: 37.785, west: -122.4115, north: 37.791, east: -122.4035 },
    frame: { originLat: 37.787935, originLon: -122.40752, originElevationM: 23.94, gridBearingDeg: 80.686, lat0Deg: 37.788 },
  });
  assert.match(src, /M_PER_DEG_LAT = 110992\.476/);
  assert.match(src, /M_PER_DEG_LON = 88084\.677/);
  assert.match(src, /ORIGIN_ELEVATION_M = 23\.94/);
});

/* -------------------------------------------------------------- provenance */

test('a fact without a source is a build error', () => {
  assert.throws(() => fact(42, { unit: 'm', license: 'CC0-1.0' }), /sourceId/);
  assert.throws(() => fact(42, { unit: 'm', sourceId: 'x' }), /license/);
});

test('reconcile prefers the survey over the popular number and records the conflict', () => {
  // The Yasaka Pagoda case: 38.79 m measured, 46 m repeated everywhere.
  const survey = fact(38.79, { unit: 'm', sourceId: 'hamashima-1969-aij', license: 'CC-BY-4.0', confidence: 'high' });
  const popular = fact(46, { unit: 'm', sourceId: 'wikidata', license: 'CC0-1.0', confidence: 'medium' });
  const { chosen, conflicts } = reconcile([popular, survey]);
  assert.equal(chosen.value, 38.79, 'the high-confidence survey must win');
  assert.equal(conflicts.length, 1);
  assert.ok(conflicts[0].deltaRel > 0.15);
});

test('reconcile never averages disagreeing sources', () => {
  const a = fact(10, { unit: 'm', sourceId: 'a', license: 'CC0-1.0', confidence: 'high' });
  const b = fact(20, { unit: 'm', sourceId: 'b', license: 'CC0-1.0', confidence: 'low' });
  assert.equal(reconcile([a, b]).chosen.value, 10);
});

test('values inside the tolerance are not reported as conflicts', () => {
  const a = fact(100, { unit: 'm', sourceId: 'a', license: 'CC0-1.0', confidence: 'high' });
  const b = fact(101, { unit: 'm', sourceId: 'b', license: 'CC0-1.0', confidence: 'medium' });
  assert.equal(reconcile([a, b]).conflicts.length, 0);
});

/* ----------------------------------------------------------------- licences */

test('every registered adapter declares a licence the registry knows', () => {
  for (const a of Object.values(ADAPTERS)) {
    assert.doesNotThrow(() => assertKnownLicense(a.license), `${a.id} has an unregistered licence`);
    assert.ok(a.attribution, `${a.id} declares no attribution`);
    assert.ok(Array.isArray(a.provides) && a.provides.length, `${a.id} declares nothing in provides`);
  }
});

test('verify rejects a dataset whose source is reference-only', () => {
  const problems = verify({
    sources: [{
      id: 'google-earth', license: 'PROPRIETARY-REFERENCE-ONLY',
      attribution: 'Google', fetchedUtc: '2026-09-03T00:00:00Z',
    }],
    provenanceByKey: {},
  });
  assert.ok(problems.some((p) => /must not contribute shipped bytes/.test(p)));
});

test('verify rejects an unattributed share-alike source and a missing fetch time', () => {
  const problems = verify({
    sources: [{ id: 'osm-overpass', license: 'ODbL-1.0', attribution: '', fetchedUtc: 'not-a-date' }],
    provenanceByKey: {},
  });
  assert.ok(problems.some((p) => /requires attribution/.test(p)));
  assert.ok(problems.some((p) => /fetchedUtc/.test(p)));
});

test('verify accepts a well-formed dataset', () => {
  assert.deepEqual(verify({
    sources: [{ id: 'osm-overpass', license: 'ODbL-1.0', attribution: '© OpenStreetMap contributors', fetchedUtc: '2026-09-03T00:00:00Z' }],
    provenanceByKey: { buildings: ['osm-overpass'] },
    storefronts: [{ id: 'a', sources: ['osm-overpass'] }],
  }), []);
});

/* --------------------------------------------------------------- storefronts */

const osmPoi = (id, name, lat, lon) => ({
  id, name, pos: [0, 0], geo: { lat, lon }, tags: {}, brand: null, category: 'shop', address: null,
});
const ovPlace = (id, name, lat, lon, confidence = 'high') => ({
  id, name, brand: name, brandWikidata: null, category: 'shop', address: null, website: null,
  pos: [0, 0], geo: { lat, lon }, confidence, confidenceRaw: 0.9,
});

test('two corpora naming the same shop at the same spot corroborate to high confidence', () => {
  const out = reconcileStorefronts({
    osmPois: [osmPoi('osm/1', 'Apple Union Square', 37.78848, -122.40691)],
    overturePlaces: [ovPlace('ov/1', 'Apple', 37.78849, -122.40692)],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].confidence, 'high');
  assert.deepEqual(out[0].sources, ['osm-overpass', 'overture']);
  assert.ok(out[0].corroboration.distanceM < 5);
});

test('a nearby contradictory name is flagged, never silently preferred', () => {
  const out = reconcileStorefronts({
    osmPois: [osmPoi('osm/1', 'Dragon Gate', 37.7900, -122.4060)],
    overturePlaces: [ovPlace('ov/2', 'Michael Fine Art and Antiques', 37.79008, -122.40607)],
  });
  const rec = out.find((s) => s.id === 'osm/1');
  assert.equal(rec.name, 'Dragon Gate', 'the OSM identity must survive');
  assert.ok(rec.conflict, 'the disagreement must be recorded');
  assert.equal(rec.sources.length, 1, 'a contradiction is not corroboration');
});

test('an unmatched Overture place becomes a candidate, not a resolved storefront', () => {
  const out = reconcileStorefronts({ osmPois: [], overturePlaces: [ovPlace('ov/3', 'Kith', 37.788, -122.407)] });
  assert.equal(out[0].status, 'candidate');
  assert.deepEqual(out[0].sources, ['overture']);
});

test('low-confidence Overture places are dropped rather than rendered', () => {
  const out = reconcileStorefronts({ osmPois: [], overturePlaces: [ovPlace('ov/4', 'Maybe Shop', 37.788, -122.407, 'low')] });
  assert.equal(out.length, 0, 'the brief forbids hallucinating a brand into an unknown location');
});

test('name matching tolerates punctuation and branch suffixes but not different brands', () => {
  const matched = reconcileStorefronts({
    osmPois: [osmPoi('osm/5', 'Nintendo SAN FRANCISCO', 37.7868, -122.4082)],
    overturePlaces: [ovPlace('ov/5', 'Nintendo', 37.78681, -122.40821)],
  });
  assert.equal(matched[0].sources.length, 2);

  const unmatched = reconcileStorefronts({
    osmPois: [osmPoi('osm/6', 'Nintendo SAN FRANCISCO', 37.7868, -122.4082)],
    overturePlaces: [ovPlace('ov/6', 'Sega World', 37.78681, -122.40821)],
  });
  assert.equal(unmatched.find((s) => s.id === 'osm/6').sources.length, 1);
});

test('places beyond the match radius do not merge', () => {
  const out = reconcileStorefronts({
    osmPois: [osmPoi('osm/7', 'Zara', 37.7880, -122.4070)],
    overturePlaces: [ovPlace('ov/7', 'Zara', 37.7890, -122.4070)], // ~111 m north
    radiusM: 20,
  });
  assert.equal(out.find((s) => s.id === 'osm/7').sources.length, 1);
  assert.ok(out.some((s) => s.status === 'candidate'));
});

test('summarise counts the categories the QA report needs', () => {
  const s = summarise(reconcileStorefronts({
    osmPois: [osmPoi('osm/8', 'Apple', 37.788, -122.407)],
    overturePlaces: [ovPlace('ov/8', 'Apple', 37.788, -122.407), ovPlace('ov/9', 'Kith', 37.7885, -122.4075)],
  }));
  assert.equal(s.resolved, 1);
  assert.equal(s.corroborated, 1);
  assert.equal(s.candidates, 1);
});

/* ---------------------------------------------------------------- GTFS CSV */

test('parseCsv handles quoted fields containing commas', () => {
  const rows = parseCsv('stop_id,stop_name,stop_lat\n1,"Powell St, Geary",37.7868\n2,Market St,37.78\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].stop_name, 'Powell St, Geary');
  assert.equal(rows[1].stop_name, 'Market St');
});

test('parseCsv handles escaped quotes and a UTF-8 BOM', () => {
  const rows = parseCsv('﻿stop_id,stop_name\n1,"The ""Wharf"" stop"\n');
  assert.equal(rows[0].stop_id, '1');
  assert.equal(rows[0].stop_name, 'The "Wharf" stop');
});

test('parseCsv tolerates CRLF and a missing trailing newline', () => {
  const rows = parseCsv('a,b\r\n1,2\r\n3,4');
  assert.deepEqual(rows, [{ a: '1', b: '2' }, { a: '3', b: '4' }]);
});

/* --------------------------------------------------- 3DEP resolution units */

test('3DEP resolution in metres is passed through unchanged', () => {
  // San Francisco: projected 1 m lidar raster.
  const r = resolutionOf({ resolution: 1 }, 37.788);
  assert.equal(r.resolutionM, 1);
  assert.equal(r.resolutionUnit, 'metres');
});

test('3DEP resolution in degrees is converted, not reported as micrometres', () => {
  // UNC Chapel Hill: 1/9 arc-second geographic raster answers 0.0000308641975.
  // Reported verbatim as "metres" this reads as 30 micrometre resolution.
  const r = resolutionOf({ resolution: 0.0000308641975 }, 35.911);
  assert.equal(r.resolutionUnit, 'degrees');
  assert.ok(r.resolutionM > 3 && r.resolutionM < 4, `expected ~3.4 m, got ${r.resolutionM}`);
  assert.equal(r.resolutionRaw, 0.0000308641975);
});

test('a missing or non-numeric 3DEP resolution degrades to null', () => {
  assert.equal(resolutionOf({}, 35.9).resolutionM, null);
  assert.equal(resolutionOf({ resolution: 'n/a' }, 35.9).resolutionM, null);
});

/* ------------------------------------------------------------- building heights */

const ring = (w, d) => [[0, 0], [w, 0], [w, d], [0, d], [0, 0]];
const osmB = (id, name, heightM, levels, w = 50, d = 50) => ({
  id, name, footprint: ring(w, d), heightM, levels,
  heightSource: heightM != null ? 'osm:height' : null, tags: {},
});
const ovtB = (id, name, heightM, w = 50, d = 50) => ({
  id: `overture/${id}`, name, footprint: ring(w, d), heightM, levels: null, roofShape: null,
});

test('an impossible storey height is rejected, not shipped', () => {
  // The Davis Library case: Overture offered 11.73 m for an 8-floor building.
  const { buildings, warnings } = reconcileBuildings({
    osmBuildings: [osmB('way/44343213', 'Walter Royal Davis Library', null, 8, 100, 74)],
    overtureBuildings: [ovtB('d605', 'Walter Royal Davis Library', 11.73, 100, 74)],
  });
  const davis = buildings.find((b) => b.id === 'way/44343213');
  assert.equal(davis.heightM, null, 'a 1.47 m storey height must not survive');
  assert.ok(davis.heightRejected, 'the rejection must be recorded, not silent');
  assert.ok(warnings.some((w) => w.kind === 'implausible-height'));
});

test('a single-source height is kept but flagged as uncorroborated', () => {
  const { buildings, warnings } = reconcileBuildings({
    osmBuildings: [osmB('way/1', 'Hall', null, null)],
    overtureBuildings: [ovtB('o1', 'Hall', 30)],
  });
  const b = buildings.find((x) => x.id === 'way/1');
  assert.equal(b.heightM, 30);
  assert.equal(b.heightConfidence, 'single-source');
  assert.ok(warnings.some((w) => w.kind === 'uncorroborated-height'));
});

test('two sources that agree corroborate the height', () => {
  const { buildings } = reconcileBuildings({
    osmBuildings: [osmB('way/2', 'Tower', 52, 15)],
    overtureBuildings: [ovtB('o2', 'Tower', 52.4)],
  });
  const b = buildings.find((x) => x.id === 'way/2');
  assert.equal(b.heightConfidence, 'corroborated');
  assert.equal(b.heightConflicts, null);
});

test('two sources that disagree produce a dispute, not a silent winner', () => {
  const { buildings, warnings } = reconcileBuildings({
    osmBuildings: [osmB('way/3', 'Block', 40, null)],
    overtureBuildings: [ovtB('o3', 'Block', 12)],
  });
  const b = buildings.find((x) => x.id === 'way/3');
  assert.equal(b.heightConfidence, 'disputed');
  assert.equal(b.heightM, 40, 'the higher-confidence OSM height tag wins');
  assert.ok(b.heightConflicts.length === 1);
  assert.ok(warnings.some((w) => w.kind === 'disputed-height'));
});

test('footprints too far apart or too different in area do not merge', () => {
  const { buildings } = reconcileBuildings({
    osmBuildings: [osmB('way/4', 'A', null, null, 50, 50)],
    overtureBuildings: [ovtB('o4', 'A', 30, 10, 10)], // 100 m2 vs 2500 m2
  });
  assert.equal(buildings.find((x) => x.id === 'way/4').heightM, null);
  assert.ok(buildings.some((b) => b.unmatched));
});

test('storeyCheck returns null when the storey count is unknown', () => {
  assert.equal(storeyCheck(11.73, null), null);
  assert.equal(storeyCheck(11.73, 8).ok, false);
  assert.equal(storeyCheck(29, 8).ok, true);
});

test('a lidar measurement outranks both estimates', () => {
  // The Davis Library resolution: OSM silent, Overture wrong at 11.73 m,
  // lidar measures 26.98 m from 8,384 roof returns.
  const { buildings } = reconcileBuildings({
    osmBuildings: [osmB('way/44343213', 'Walter Royal Davis Library', null, null, 128, 115)],
    overtureBuildings: [ovtB('d605', 'Walter Royal Davis Library', 11.73, 128, 115)],
    lidarHeights: [{ id: 'way/44343213', heightM: 26.98, roofM: 172.05, groundM: 145.07, points: 8384, confidence: 'high' }],
  });
  const b = buildings.find((x) => x.id === 'way/44343213');
  assert.equal(b.heightM, 26.98, 'the measured height must win');
  assert.equal(b.heightConfidence, 'disputed', 'Overture disagreeing must still be recorded');
  assert.ok(b.heightConflicts.some((c) => c.sourceId === 'overture' && c.value === 11.73));
  assert.equal(b.lidar.points, 8384);
});

test('a lidar height is exempt from the storey gate; the levels tag is the suspect', () => {
  const { buildings } = reconcileBuildings({
    osmBuildings: [osmB('way/9', 'Odd', null, 20)], // a bogus levels tag
    overtureBuildings: [],
    lidarHeights: [{ id: 'way/9', heightM: 12, points: 900, confidence: 'high' }],
  });
  const b = buildings.find((x) => x.id === 'way/9');
  assert.equal(b.heightM, 12, 'the measurement survives a nonsense levels tag');
});

test('a thinly-sampled lidar roof does not automatically outrank a good OSM tag', () => {
  const { buildings } = reconcileBuildings({
    osmBuildings: [osmB('way/10', 'Hall', 30, 9)],
    overtureBuildings: [],
    lidarHeights: [{ id: 'way/10', heightM: 18, points: 40, confidence: 'low' }],
  });
  const b = buildings.find((x) => x.id === 'way/10');
  assert.equal(b.heightM, 30, 'a 40-return roof should not beat an explicit height tag');
  assert.equal(b.heightConfidence, 'disputed');
});
