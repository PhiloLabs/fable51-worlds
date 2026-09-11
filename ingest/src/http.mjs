/**
 * http.mjs — polite, cached, retrying HTTP for the ingest adapters.
 *
 * Every public dataset this repo pulls from is someone else's free infrastructure
 * (Overpass, USGS EPQS, GSI, Wikidata, Wikimedia). Three rules keep us welcome:
 *   1. a real User-Agent that names the project and a contact URL,
 *   2. a per-host minimum interval between requests,
 *   3. an on-disk cache so a re-run of the pipeline costs zero upstream requests.
 *
 * The cache is content-addressed on the full request (method + url + body) and
 * stores a provenance sidecar next to each payload, so `ingest verify` can prove
 * when every byte was fetched and from where.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const USER_AGENT =
  'fable51-worlds-ingest/0.1 (+https://github.com/PhiloLabs/fable51-worlds)';

/** Minimum milliseconds between requests to the same host. Overpass asks for <=1 req/s. */
const HOST_INTERVAL_MS = {
  'overpass-api.de': 1500,
  'overpass.kumi.systems': 1500,
  'epqs.nationalmap.gov': 250,
  'cyberjapandata.gsi.go.jp': 250,
  'query.wikidata.org': 1200,
  'commons.wikimedia.org': 250,
  'www.geospatial.jp': 500,
  'graph.mapillary.com': 100,
  default: 200,
};

const lastRequestAt = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function throttle(host) {
  const interval = HOST_INTERVAL_MS[host] ?? HOST_INTERVAL_MS.default;
  const last = lastRequestAt.get(host) ?? 0;
  const wait = last + interval - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt.set(host, Date.now());
}

const cacheKey = (method, url, body) =>
  createHash('sha256').update(`${method}\n${url}\n${body ?? ''}`).digest('hex').slice(0, 40);

/**
 * Fetch with disk cache, throttling and exponential backoff.
 *
 * @param {string} url
 * @param {object} opts
 * @param {string} [opts.method='GET']
 * @param {string} [opts.body]
 * @param {Record<string,string>} [opts.headers]
 * @param {string} opts.cacheDir       directory to store payload + provenance sidecar
 * @param {number} [opts.maxAgeMs]     re-fetch if the cached copy is older than this
 * @param {boolean} [opts.refresh]     ignore any cached copy
 * @param {number} [opts.retries=4]
 * @param {number} [opts.timeoutMs=120000]
 * @returns {Promise<{body: string, fromCache: boolean, provenance: object}>}
 */
export async function fetchCached(url, opts) {
  const {
    method = 'GET', body, headers = {}, cacheDir,
    maxAgeMs = Infinity, refresh = false, retries = 4, timeoutMs = 120_000,
  } = opts;
  if (!cacheDir) throw new Error('fetchCached: cacheDir is required');

  const key = cacheKey(method, url, body);
  const payloadPath = path.join(cacheDir, `${key}.body`);
  const metaPath = path.join(cacheDir, `${key}.json`);
  await fs.mkdir(cacheDir, { recursive: true });

  if (!refresh) {
    try {
      const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
      const age = Date.now() - Date.parse(meta.fetchedUtc);
      if (age <= maxAgeMs) {
        return { body: await fs.readFile(payloadPath, 'utf8'), fromCache: true, provenance: meta };
      }
    } catch {
      /* cache miss — fall through to the network */
    }
  }

  const host = new URL(url).host;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(Math.min(30_000, 1000 * 2 ** attempt));
    await throttle(host);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        body,
        signal: ac.signal,
        headers: { 'User-Agent': USER_AGENT, ...headers },
      });
      // 429 and 5xx are transient; other 4xx will never succeed on retry.
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`${res.status} ${res.statusText} from ${host}`);
        continue;
      }
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${url}`);
      const text = await res.text();
      const provenance = {
        url,
        method,
        requestSha256: createHash('sha256').update(body ?? '').digest('hex'),
        responseSha256: createHash('sha256').update(text).digest('hex'),
        bytes: Buffer.byteLength(text),
        status: res.status,
        fetchedUtc: new Date().toISOString(),
      };
      await fs.writeFile(payloadPath, text);
      await fs.writeFile(metaPath, JSON.stringify(provenance, null, 2));
      return { body: text, fromCache: false, provenance };
    } catch (err) {
      lastErr = err?.name === 'AbortError' ? new Error(`timeout after ${timeoutMs}ms: ${url}`) : err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`fetch failed after ${retries + 1} attempts: ${lastErr?.message}`);
}

/**
 * Binary-safe fetch with the same disk cache and throttling.
 *
 * Kept separate from `fetchCached` on purpose: that one round-trips through a UTF-8
 * string, which silently corrupts every byte outside the ASCII range. Reference
 * photographs must come through here.
 *
 * @returns {Promise<{buffer: Buffer, fromCache: boolean, provenance: object}>}
 */
export async function fetchBinary(url, opts) {
  const { headers = {}, cacheDir, maxAgeMs = Infinity, refresh = false, retries = 3, timeoutMs = 120_000 } = opts;
  if (!cacheDir) throw new Error('fetchBinary: cacheDir is required');

  const key = cacheKey('GET', url, undefined);
  const payloadPath = path.join(cacheDir, `${key}.bin`);
  const metaPath = path.join(cacheDir, `${key}.bin.json`);
  await fs.mkdir(cacheDir, { recursive: true });

  if (!refresh) {
    try {
      const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
      if (Date.now() - Date.parse(meta.fetchedUtc) <= maxAgeMs) {
        return { buffer: await fs.readFile(payloadPath), fromCache: true, provenance: meta };
      }
    } catch { /* miss */ }
  }

  const host = new URL(url).host;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(Math.min(30_000, 1000 * 2 ** attempt));
    await throttle(host);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': USER_AGENT, ...headers } });
      if (res.status === 429 || res.status >= 500) { lastErr = new Error(`${res.status} from ${host}`); continue; }
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${url}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      const provenance = {
        url,
        contentType: res.headers.get('content-type'),
        responseSha256: createHash('sha256').update(buffer).digest('hex'),
        bytes: buffer.byteLength,
        status: res.status,
        fetchedUtc: new Date().toISOString(),
      };
      await fs.writeFile(payloadPath, buffer);
      await fs.writeFile(metaPath, JSON.stringify(provenance, null, 2));
      return { buffer, fromCache: false, provenance };
    } catch (err) {
      lastErr = err?.name === 'AbortError' ? new Error(`timeout after ${timeoutMs}ms: ${url}`) : err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`binary fetch failed after ${retries + 1} attempts: ${lastErr?.message}`);
}

/** Convenience wrapper that parses JSON and reports the offending URL on a parse error. */
export async function fetchJson(url, opts) {
  const r = await fetchCached(url, opts);
  try {
    return { ...r, json: JSON.parse(r.body) };
  } catch {
    throw new Error(`non-JSON response from ${url}: ${r.body.slice(0, 200)}`);
  }
}
