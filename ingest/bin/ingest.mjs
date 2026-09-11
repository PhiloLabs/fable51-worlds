#!/usr/bin/env node
/**
 * ingest — reproducible data ingress for fable51-worlds.
 *
 *   node ingest/bin/ingest.mjs sources
 *   node ingest/bin/ingest.mjs fetch union-square-sf [--only osm-overpass] [--skip overture] [--refresh]
 *   node ingest/bin/ingest.mjs build union-square-sf [--pretty]
 *   node ingest/bin/ingest.mjs verify union-square-sf
 *
 * No dependencies. Node >= 20.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTERS } from '../src/sources/index.mjs';
import { LICENSES } from '../src/licenses.mjs';
import { loadWorld, runSources, mergeDataset, build, verify } from '../src/pipeline.mjs';
import { summarise } from '../src/storefronts.mjs';
import { downloadReferences } from '../src/refs.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const argv = process.argv.slice(2);
const command = argv[0];
const positional = argv.slice(1).filter((a) => !a.startsWith('--'));
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const list = (name) => value(name)?.split(',').map((s) => s.trim()).filter(Boolean);

const log = (m) => process.stderr.write(`${m}\n`);

function usage(code = 0) {
  process.stdout.write(`ingest — reproducible data ingress for fable51-worlds

Commands
  sources                     list every adapter, what it provides, what it needs
  worlds                      list the world manifests in ingest/worlds/
  fetch <world>               run the sources and report, without writing the dataset
  build <world>               fetch, merge, reconcile, write <outDir>/ingest.json + paper trail
  verify <world>              re-check an existing dataset's provenance and licensing

Flags
  --only  a,b     run only these sources
  --skip  a,b     skip these sources
  --refresh       ignore the HTTP cache
  --max-age-days  re-fetch anything cached longer than this (default 7)
  --pretty        pretty-print the dataset JSON
  --json          machine-readable output where applicable
`);
  process.exit(code);
}

async function listWorlds() {
  const dir = path.join(REPO_ROOT, 'ingest', 'worlds');
  const files = (await fs.readdir(dir).catch(() => [])).filter((f) => f.endsWith('.json'));
  return files.map((f) => f.replace(/\.json$/, ''));
}

function commonOpts() {
  const days = Number(value('max-age-days') ?? 7);
  return {
    only: list('only') ?? null,
    skip: list('skip') ?? [],
    refresh: flag('refresh'),
    maxAgeMs: days * 24 * 3600 * 1000,
    pretty: flag('pretty'),
    log,
  };
}

async function main() {
  if (!command || flag('help') || command === 'help') usage();

  if (command === 'sources') {
    const rows = Object.values(ADAPTERS).map((a) => ({
      id: a.id,
      license: a.license,
      class: LICENSES[a.license]?.class ?? '?',
      provides: a.provides.join(' '),
      requires: a.requires.length ? a.requires.join(' ') : '—',
      region: a.appliesTo ? (a.appliesTo({ region: 'us' }) ? 'us' : 'jp') : 'any',
      ready: a.available ? (a.available() ? 'yes' : 'no') : 'yes',
    }));
    if (flag('json')) { process.stdout.write(JSON.stringify(rows, null, 2) + '\n'); return; }
    const w = (s, n) => String(s).padEnd(n);
    process.stdout.write(
      `${w('SOURCE', 20)}${w('LICENCE', 16)}${w('CLASS', 15)}${w('REGION', 8)}${w('READY', 7)}PROVIDES\n`,
    );
    for (const r of rows) {
      process.stdout.write(
        `${w(r.id, 20)}${w(r.license, 16)}${w(r.class, 15)}${w(r.region, 8)}${w(r.ready, 7)}${r.provides}\n`,
      );
    }
    const needs = Object.values(ADAPTERS).filter((a) => a.requires.length);
    if (needs.length) {
      process.stdout.write('\nExternal requirements:\n');
      for (const a of needs) process.stdout.write(`  ${a.id}: ${a.requires.join(', ')}\n`);
    }
    return;
  }

  if (command === 'worlds') {
    for (const id of await listWorlds()) process.stdout.write(`${id}\n`);
    return;
  }

  const worldId = positional[0];
  if (!worldId) { log(`error: ${command} needs a world id. Known: ${(await listWorlds()).join(', ')}`); process.exit(2); }
  const world = await loadWorld(REPO_ROOT, worldId);

  if (command === 'fetch') {
    log(`fetching ${world.id} (${world.sources.length} declared sources)`);
    const results = await runSources(REPO_ROOT, world, commonOpts());
    const dataset = mergeDataset(results, world);
    const counts = Object.fromEntries(
      Object.entries(dataset).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, v.length]),
    );
    process.stdout.write(JSON.stringify({ world: world.id, counts, sources: dataset.sources }, null, 2) + '\n');
    return;
  }

  if (command === 'build') {
    log(`building ${world.id}`);
    const { dataset, register } = await build(REPO_ROOT, world, commonOpts());
    const counts = Object.fromEntries(
      Object.entries(dataset).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, v.length]),
    );
    log('');
    log(`wrote ${world.outDir}/ingest.json`);
    for (const [k, n] of Object.entries(counts)) log(`  ${k}: ${n}`);
    if (dataset.storefronts) {
      const s = summarise(dataset.storefronts);
      log(`  storefronts: ${s.resolved} resolved (${s.corroborated} corroborated by 2 sources), ` +
          `${s.candidates} candidates, ${s.conflicts} conflicts`);
    }
    const conflicts = register.reduce((n, e) => n + e.conflicts.length, 0);
    if (conflicts) log(`  ${conflicts} measurement conflicts -> ${world.outDir}/UNCERTAINTY.md`);
    const problems = verify(dataset);
    if (problems.length) { log(''); for (const p of problems) log(`VERIFY FAIL: ${p}`); process.exit(1); }
    log('verify: ok');
    return;
  }

  if (command === 'refs') {
    const p = path.join(REPO_ROOT, world.outDir, 'ingest.json');
    let dataset;
    try {
      dataset = JSON.parse(await fs.readFile(p, 'utf8'));
    } catch {
      log(`error: no dataset at ${world.outDir}/ingest.json — run \`build ${world.id}\` first`);
      process.exit(2);
    }
    const refs = dataset.referenceImages ?? [];
    if (!refs.length) {
      log(`error: no referenceImages in the dataset — is wikimedia-commons declared in the manifest?`);
      process.exit(2);
    }
    const perViewpoint = Number(value('per-viewpoint') ?? 6);
    log(`downloading up to ${perViewpoint} references per viewpoint into ${world.worldDir}/refs/`);
    const r = await downloadReferences(REPO_ROOT, world, refs, { perViewpoint, log });
    log(`refs: ${r.written} images across ${r.viewpoints} viewpoints (${r.failed} failed)`);
    return;
  }

  if (command === 'verify') {
    const p = path.join(REPO_ROOT, world.outDir, 'ingest.json');
    let dataset;
    try {
      dataset = JSON.parse(await fs.readFile(p, 'utf8'));
    } catch {
      log(`error: no dataset at ${world.outDir}/ingest.json — run \`build ${world.id}\` first`);
      process.exit(2);
    }
    const problems = verify(dataset);
    if (problems.length) { for (const x of problems) log(`VERIFY FAIL: ${x}`); process.exit(1); }
    log(`verify ${world.id}: ok (${dataset.sources.length} sources, generated ${dataset.generatedUtc})`);
    return;
  }

  log(`unknown command "${command}"`);
  usage(2);
}

main().catch((err) => {
  log(`\nerror: ${err.message}`);
  if (process.env.DEBUG) log(err.stack);
  process.exit(1);
});
