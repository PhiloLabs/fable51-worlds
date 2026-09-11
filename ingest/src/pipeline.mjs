/**
 * pipeline.mjs — run a world's declared sources, merge them, and write the dataset
 * the runtime loads.
 *
 * The contract the whole package exists to enforce: `ingest build <world>` is
 * deterministic given a fixed cache. Two people who clone the repo and run it get
 * byte-identical data files, and every record in them can name the dataset,
 * licence and fetch time it came from.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createFrame, emitRuntimeModule } from './geo.mjs';
import { getAdapter } from './sources/index.mjs';
import { assertKnownLicense, renderAttribution, LICENSES } from './licenses.mjs';
import { reconcile, renderUncertaintyRegister } from './provenance.mjs';
import { reconcileStorefronts } from './storefronts.mjs';
import { reconcileBuildings, summariseBuildings } from './buildings.mjs';

/** Load and sanity-check a world manifest. */
export async function loadWorld(repoRoot, worldId) {
  const p = path.join(repoRoot, 'ingest', 'worlds', `${worldId}.json`);
  let text;
  try {
    text = await fs.readFile(p, 'utf8');
  } catch {
    const dir = path.join(repoRoot, 'ingest', 'worlds');
    const available = (await fs.readdir(dir).catch(() => [])).filter((f) => f.endsWith('.json'));
    throw new Error(
      `no manifest at ingest/worlds/${worldId}.json. Available: ${available.map((f) => f.replace('.json', '')).join(', ') || '(none)'}`,
    );
  }
  const world = JSON.parse(text);
  for (const key of ['id', 'bbox', 'frame', 'sources', 'outDir']) {
    if (world[key] == null) throw new Error(`world manifest ${worldId}: missing "${key}"`);
  }
  if (world.id !== worldId) throw new Error(`world manifest ${worldId}: id field says "${world.id}"`);
  for (const s of world.sources) assertKnownLicense(getAdapter(s.adapter).license);
  return world;
}

/**
 * Fetch every applicable source. Sources are independent, so they run
 * concurrently — but bounded, because several of them hit the same rate-limited
 * hosts and `http.mjs` serialises per host anyway.
 */
export async function runSources(repoRoot, world, opts = {}) {
  const { only = null, skip = [], refresh = false, maxAgeMs = 7 * 24 * 3600 * 1000, log = () => {} } = opts;
  const frame = createFrame(world.frame);
  const cacheDir = path.join(repoRoot, '.ingest-cache', world.id);

  const results = [];
  // Sources run in manifest order and each one can read what earlier sources
  // produced. usgs-lidar-lpc needs osm-overpass's footprints; declaring it after
  // osm-overpass is what makes that work.
  const soFar = {};
  for (const decl of world.sources) {
    const adapter = getAdapter(decl.adapter);
    const label = decl.adapter;

    if (only && !only.includes(label)) continue;
    if (skip.includes(label)) { log(`- ${label}: skipped by flag`); continue; }
    if (adapter.appliesTo && !adapter.appliesTo(world)) {
      log(`- ${label}: not applicable to region "${world.region}"`);
      continue;
    }
    if (adapter.available && !adapter.available()) {
      log(`- ${label}: unavailable (needs ${adapter.requires.join(', ')}) — skipping`);
      results.push({ id: label, adapter, status: 'skipped', reason: `missing ${adapter.requires.join(', ')}` });
      continue;
    }

    const ctx = {
      world, frame, cacheDir: path.join(cacheDir, label), refresh, maxAgeMs,
      options: decl.options ?? {}, marginM: world.clipMarginM ?? 60,
      priorData: soFar, buildings: soFar.buildings ?? [],
      log: (m) => log(`  ${m}`),
      progress: opts.progress,
    };

    const started = Date.now();
    try {
      log(`- ${label}: fetching`);
      const { raw, provenance } = await adapter.fetch(ctx);
      const data = adapter.normalize(raw, ctx) ?? {};
      for (const [k, v] of Object.entries(data)) {
        if (Array.isArray(v) && Array.isArray(soFar[k])) soFar[k] = soFar[k].concat(v);
        else soFar[k] = v;
      }
      results.push({
        id: label, adapter, status: 'ok', data,
        provenance: { ...provenance, license: adapter.license, fetchedUtc: provenance?.fetchedUtc ?? new Date().toISOString() },
        elapsedMs: Date.now() - started,
      });
      log(`  ok in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    } catch (err) {
      const required = decl.required !== false;
      log(`  ${required ? 'FAILED' : 'failed (optional)'}: ${err.message}`);
      results.push({ id: label, adapter, status: 'error', error: err.message });
      if (required) throw new Error(`required source "${label}" failed: ${err.message}`);
    }
  }
  return results;
}

/** Merge normalized fragments into one dataset, recording which source won each key. */
export function mergeDataset(results, world) {
  const dataset = {
    world: world.id,
    generatedUtc: new Date().toISOString(),
    frame: world.frame,
    bbox: world.bbox,
    sources: [],
  };
  const provenanceByKey = {};

  for (const r of results) {
    if (r.status !== 'ok') continue;
    dataset.sources.push({
      id: r.id,
      title: r.adapter.title,
      license: r.adapter.license,
      attribution: r.adapter.attribution,
      homepage: r.adapter.homepage,
      fetchedUtc: r.provenance.fetchedUtc,
      ...(r.provenance.release ? { release: r.provenance.release } : {}),
    });
    for (const [key, value] of Object.entries(r.data)) {
      if (Array.isArray(value) && Array.isArray(dataset[key])) {
        dataset[key] = dataset[key].concat(value);
        provenanceByKey[key] = [...new Set([...(provenanceByKey[key] ?? []), r.id])];
      } else {
        dataset[key] = value;
        provenanceByKey[key] = [r.id];
      }
    }
  }
  dataset.provenanceByKey = provenanceByKey;
  return dataset;
}

/** Full build: fetch, merge, reconcile, write, and generate the paper trail. */
export async function build(repoRoot, world, opts = {}) {
  const log = opts.log ?? (() => {});
  const results = await runSources(repoRoot, world, opts);
  const dataset = mergeDataset(results, world);

  // Cross-check landmark measurements against Wikidata rather than averaging them.
  const register = [];
  if (dataset.wikidataLandmarks?.length && world.landmarkChecks?.length) {
    for (const check of world.landmarkChecks) {
      const wd = dataset.wikidataLandmarks.find((l) => l.qid === check.qid);
      const facts = [
        {
          value: check.surveyValue, unit: check.unit, sourceId: check.surveySourceId,
          license: 'CC-BY-4.0', confidence: 'high', note: check.note,
          fetchedUtc: dataset.generatedUtc,
        },
      ];
      if (wd?.facts?.[check.property]) {
        facts.push({
          value: wd.facts[check.property].value, unit: wd.facts[check.property].unit,
          sourceId: 'wikidata', license: 'CC0-1.0', confidence: 'medium',
          ref: wd.qid, fetchedUtc: dataset.generatedUtc,
        });
      }
      const { chosen, conflicts } = reconcile(facts);
      register.push({ key: `${check.label} — ${check.property}`, chosen, conflicts });
    }
  }

  // Merge building footprints across sources. Heights get the same corroboration
  // discipline as storefronts: one source is `single-source`, two that disagree is
  // `disputed`, and a height implying an impossible storey height is rejected.
  if (dataset.buildings?.length) {
    const osmB = dataset.buildings.filter((b) => !b.id.startsWith('overture/'));
    const ovtB = dataset.buildings.filter((b) => b.id.startsWith('overture/'));
    const r = reconcileBuildings({
      osmBuildings: osmB, overtureBuildings: ovtB,
      lidarHeights: dataset.lidarHeights ?? [],
    });
    dataset.buildings = r.buildings;
    dataset.buildingWarnings = r.warnings;
    const s = summariseBuildings(r.buildings);
    log(`  heights: ${s.corroborated} corroborated, ${s.singleSource} single-source, ` +
        `${s.disputed} disputed, ${s.rejected} rejected as implausible, ${s.noHeight} unknown`);
  }

  // Merge OSM POIs with Overture places into one storefront registry.
  if (dataset.pois || dataset.places) {
    dataset.storefronts = reconcileStorefronts({
      osmPois: dataset.pois ?? [],
      overturePlaces: dataset.places ?? [],
      radiusM: world.storefrontMatchRadiusM ?? 20,
    });
  }

  const outDir = path.join(repoRoot, world.outDir);
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'ingest.json'), JSON.stringify(dataset, null, opts.pretty ? 2 : 0));

  const used = dataset.sources.map((s) => ({ ...s }));
  await fs.writeFile(path.join(repoRoot, world.worldDir, 'ATTRIBUTION.md'), renderAttribution(world.id, used));
  await fs.writeFile(path.join(outDir, 'UNCERTAINTY.md'), renderUncertaintyRegister(world.id, register));

  if (world.emitFrameModule) {
    const lang = world.emitFrameModule.endsWith('.ts') ? 'ts' : 'js';
    const target = path.join(repoRoot, world.emitFrameModule);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, emitRuntimeModule(world, { lang }));
    log(`wrote ${world.emitFrameModule}`);
  }

  return { dataset, results, register };
}

/**
 * `ingest verify` — the gate. Fails the build on anything that would make the
 * world's data unreproducible or its licensing indefensible.
 */
export function verify(dataset) {
  const problems = [];
  if (!dataset.sources?.length) problems.push('dataset declares no sources');

  for (const s of dataset.sources ?? []) {
    const lic = LICENSES[s.license];
    if (!lic) { problems.push(`source "${s.id}" has unknown license "${s.license}"`); continue; }
    if (!lic.redistributable) {
      problems.push(`source "${s.id}" is ${lic.class} and must not contribute shipped bytes`);
    }
    if (lic.requiresAttribution && !s.attribution) {
      problems.push(`source "${s.id}" requires attribution but declares none`);
    }
    if (!s.fetchedUtc || Number.isNaN(Date.parse(s.fetchedUtc))) {
      problems.push(`source "${s.id}" has no valid fetchedUtc`);
    }
  }

  for (const [key, ids] of Object.entries(dataset.provenanceByKey ?? {})) {
    if (!ids?.length) problems.push(`dataset key "${key}" has no source attribution`);
  }

  const unsourced = (dataset.storefronts ?? []).filter((s) => !s.sources?.length);
  if (unsourced.length) problems.push(`${unsourced.length} storefronts carry no source`);

  return problems;
}
