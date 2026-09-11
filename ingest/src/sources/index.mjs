/**
 * The adapter registry. Adding a data source to fable51-worlds means writing one
 * module here and naming it in a world manifest — nothing else in the pipeline
 * changes.
 *
 * Each adapter is a plain object:
 *   id, title, license, attribution, homepage
 *   requires   : string[]  external binaries or env vars a human must provide
 *   provides   : string[]  what kinds of records it contributes
 *   appliesTo? : (world) => boolean     region gate (US-only, Japan-only, ...)
 *   available? : () => boolean          runtime gate (token present?)
 *   fetch(ctx) : => { raw, provenance }
 *   normalize(raw, ctx) => partial dataset, merged by pipeline.mjs
 */
import osmOverpass from './osm-overpass.mjs';
import overture from './overture.mjs';
import usgs3dep from './usgs-3dep.mjs';
import gsiDem from './gsi-dem.mjs';
import plateau from './plateau.mjs';
import wikidata from './wikidata.mjs';
import wikimediaCommons from './wikimedia-commons.mjs';
import gtfs from './gtfs.mjs';
import mapillary from './mapillary.mjs';
import usgsLidarLpc from './usgs-lidar-lpc.mjs';

export const ADAPTERS = Object.fromEntries(
  [osmOverpass, overture, usgs3dep, usgsLidarLpc, gsiDem, plateau, wikidata, wikimediaCommons, gtfs, mapillary]
    .map((a) => [a.id, a]),
);

export function getAdapter(id) {
  const a = ADAPTERS[id];
  if (!a) {
    throw new Error(
      `unknown source "${id}". Known sources: ${Object.keys(ADAPTERS).join(', ')}`,
    );
  }
  return a;
}
