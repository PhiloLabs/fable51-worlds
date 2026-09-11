/**
 * gtfs — transit stops, routes and shapes from a published GTFS feed.
 *
 * union-square-sf/PROMPT.md is emphatic that transit must be geographically real:
 * "Do not add transit merely for decoration if it is geographically incorrect."
 * The world currently satisfies that by hand — Muni stop poles and the Powell St
 * cable-car stop were placed from research notes. GTFS is the authoritative answer:
 * SFMTA publishes every stop's exact lat/lon and every route's shape polyline, and
 * so does virtually every transit agency on earth.
 *
 * Concretely this fixes two classes of error the QA reports cannot catch: a stop
 * pole on the wrong side of the street, and a cable-car track that diverges from
 * the real alignment where it curves into Powell.
 *
 * The feed is a zip of CSVs. Rather than take a dependency we shell out to `unzip
 * -p`, which is present on macOS, every Linux CI image, and Git-for-Windows.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const exec = promisify(execFile);

/**
 * Feeds we know about; a world manifest can also give a bare `options.feedUrl`.
 *
 * NOT VERIFIED LIVE: `gtfs.sfmta.com` refused TCP from the machine this adapter was
 * written on (connection timed out, DNS resolved fine), so the SFMTA entry is
 * unconfirmed. 511.org is the official Bay Area aggregator and redistributes the
 * same Muni feed behind a free API key — use it if the direct host is unreachable
 * for you too. The parsing path below IS exercised by ingest/test/gtfs.test.mjs
 * against fixture CSVs; it is only the download that is unproven.
 */
export const FEEDS = {
  sfmta: {
    url: 'https://gtfs.sfmta.com/transitdata/google_transit.zip',
    agency: 'San Francisco Municipal Transportation Agency',
    license: 'CC-BY-4.0',
    verified: false,
  },
  '511-bayarea': {
    // Needs ?api_key=<free key from 511.org/open-data/token>; set options.feedUrl.
    url: 'https://api.511.org/transit/datafeeds?operator_id=SF',
    agency: 'Metropolitan Transportation Commission (511 Bay Area) — Muni feed',
    license: 'CC-BY-4.0',
    verified: false,
  },
  bart: {
    url: 'https://www.bart.gov/dev/schedules/google_transit.zip',
    agency: 'Bay Area Rapid Transit',
    license: 'CC-BY-4.0',
    verified: false,
  },
};

/**
 * RFC 4180 CSV reader — GTFS quotes fields containing commas (route long names
 * routinely do), so splitting on ',' silently corrupts stop names.
 */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.replace(/^﻿/, '').trim());
  return rows.slice(1)
    .filter((r) => r.length > 1)
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

export default {
  id: 'gtfs',
  title: 'GTFS transit feed — stops, routes and track alignments',
  license: 'CC-BY-4.0',
  attribution: 'per-feed; recorded in the ingested record',
  homepage: 'https://gtfs.org/',
  requires: ['unzip'],
  provides: ['transit-stops', 'transit-routes', 'transit-shapes'],

  async fetch(ctx) {
    const key = ctx.options?.feed;
    const feed = key ? FEEDS[key] : null;
    const url = ctx.options?.feedUrl ?? feed?.url;
    if (!url) {
      throw new Error(
        `gtfs: set options.feed (one of ${Object.keys(FEEDS).join(', ')}) or options.feedUrl ` +
          'in the world manifest.',
      );
    }
    const dir = path.join(ctx.cacheDir, 'gtfs', createHash('sha256').update(url).digest('hex').slice(0, 16));
    await fs.mkdir(dir, { recursive: true });
    const zipPath = path.join(dir, 'feed.zip');

    let stale = ctx.refresh;
    try {
      const st = await fs.stat(zipPath);
      if (Date.now() - st.mtimeMs > (ctx.maxAgeMs ?? Infinity)) stale = true;
    } catch { stale = true; }

    if (stale) {
      ctx.log?.(`gtfs: downloading ${url}`);
      try {
        const res = await fetch(url, { headers: { 'User-Agent': 'fable51-worlds-ingest/0.1' } });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        await fs.writeFile(zipPath, Buffer.from(await res.arrayBuffer()));
      } catch (err) {
        // undici surfaces every transport problem as a bare "fetch failed", which
        // is useless when a transit agency's host is simply unreachable from your
        // network. Name the host and the fallback.
        const cause = err.cause?.code ?? err.cause?.message ?? err.message;
        throw new Error(
          `gtfs: could not download ${url} (${cause}). ` +
            'Transit-agency hosts are frequently unreachable from CI and from networks with ' +
            'captive DNS. Set `options.feedUrl` in the world manifest to a mirror you can ' +
            'reach (511.org serves the Bay Area feeds behind a free key), or drop this ' +
            'source — it is declared `required: false`.',
        );
      }
    }

    const read = async (member) => {
      try {
        const { stdout } = await exec('unzip', ['-p', zipPath, member], { maxBuffer: 512 * 1024 * 1024 });
        return parseCsv(stdout);
      } catch {
        return []; // shapes.txt and some optional files are legitimately absent
      }
    };

    const [stops, routes, shapes, trips] = await Promise.all([
      read('stops.txt'), read('routes.txt'), read('shapes.txt'), read('trips.txt'),
    ]);
    const bytes = (await fs.stat(zipPath)).size;
    return {
      raw: { url, agency: feed?.agency ?? ctx.options?.agency ?? null, stops, routes, shapes, trips },
      provenance: { url, bytes, fetchedUtc: new Date().toISOString() },
    };
  },

  normalize(raw, ctx) {
    const { frame, world } = ctx;
    const r2 = (v) => Math.round(v * 100) / 100;

    const stops = [];
    for (const s of raw.stops) {
      const lat = Number(s.stop_lat), lon = Number(s.stop_lon);
      if (!Number.isFinite(lat) || !frame.inBbox(world.bbox, lat, lon, ctx.marginM ?? 100)) continue;
      const l = frame.geoToLocal(lat, lon);
      stops.push({
        id: `gtfs/${s.stop_id}`,
        name: s.stop_name || null,
        code: s.stop_code || null,
        pos: [r2(l.x), r2(l.z)],
        geo: { lat, lon },
        // GTFS location_type: 0/'' = stop, 1 = station, 2 = entrance
        kind: s.location_type === '1' ? 'station' : s.location_type === '2' ? 'entrance' : 'stop',
      });
    }

    // Only keep shape points inside the world — a full agency feed is millions of rows.
    const shapePoints = new Map();
    for (const p of raw.shapes) {
      const lat = Number(p.shape_pt_lat), lon = Number(p.shape_pt_lon);
      if (!Number.isFinite(lat) || !frame.inBbox(world.bbox, lat, lon, ctx.marginM ?? 100)) continue;
      const l = frame.geoToLocal(lat, lon);
      if (!shapePoints.has(p.shape_id)) shapePoints.set(p.shape_id, []);
      shapePoints.get(p.shape_id).push({ seq: Number(p.shape_pt_sequence), pos: [r2(l.x), r2(l.z)] });
    }
    const shapeToRoute = new Map();
    for (const t of raw.trips) if (t.shape_id && !shapeToRoute.has(t.shape_id)) shapeToRoute.set(t.shape_id, t.route_id);
    const routeById = new Map(raw.routes.map((r) => [r.route_id, r]));

    const transitShapes = [...shapePoints.entries()].map(([shapeId, pts]) => {
      const routeId = shapeToRoute.get(shapeId);
      const route = routeById.get(routeId);
      return {
        id: `gtfs/shape/${shapeId}`,
        routeId: routeId ?? null,
        routeShortName: route?.route_short_name ?? null,
        routeLongName: route?.route_long_name ?? null,
        // GTFS route_type: 0 tram/streetcar (cable cars ride here), 3 bus, 5 cable tram
        routeType: route?.route_type ?? null,
        points: pts.sort((a, b) => a.seq - b.seq).map((p) => p.pos),
      };
    });

    ctx.log?.(`gtfs: ${stops.length} stops, ${transitShapes.length} route shapes inside the bbox`);
    return { transitStops: stops, transitShapes, transitAgency: raw.agency };
  },
};
