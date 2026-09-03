// World assembly: loads recon data, builds terrain, streets, plaza, buildings; owns the collision world.
import * as THREE from 'three';
import { BASE } from '../assets/Assets';
import { CollisionWorld } from '../player/Collision';
import { Terrain } from './Terrain';
import { Streets } from './Streets';
import { StreetSpec } from './StreetGrid';
import { Buildings, GisBuilding, BuildingOverride, BuildingInfo } from './Buildings';
import { Plaza } from './Plaza';
import { FacadeBuilder } from './facade/FacadeBuilder';
import { autoSpec } from './facade/AutoSpec';
import type { FacadeSpec } from './facade/FacadeSpec';
import type { StorefrontReg } from './HeroContext';
import { logoKey } from '../materials/Signage';

export interface GisData { origin: any; buildings: GisBuilding[]; buildingParts: GisBuilding[]; streets: any[]; pois: any[]; trees: any[]; lamps: any[]; signals: any[]; crossings: any[]; hydrants: any[]; benches: any[]; plaza: any; intersections: any[] }

// Fetches JSON with a request timeout so a slow/hanging server can't block loading forever.
async function fetchJson(url: string, timeoutMs = 10000): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Heights for landmark buildings whose OSM data is missing/short (metres). Keyed by address or OSM id.
export const HEIGHT_OVERRIDES: Record<string, BuildingOverride> = {
  "333 O'Farrell Street": { heightM: 46, style: 'concrete' },      // Hilton podium (towers are separate parts)
  '55 Cyril Magnin Street': { heightM: 107, style: 'concrete' },   // Parc 55
  '222 Mason Street': { heightM: 85, style: 'concrete' },          // Hotel Nikko
  '450 Sutter Street': { heightM: 105, style: 'terracotta' },      // 450 Sutter (Pflueger)
  '450 Powell Street': { heightM: 75, style: 'stone_warm' },       // Beacon Grand
  'way/184956226': { hide: true },                                  // Union Square/Market St station box (underground) — must not be extruded
  'way/616479965': { hide: true },                                  // plaza stage platform outline (built procedurally in Plaza.ts)
  'way/435582543': { style: 'travertine', floorH: 3.7, bayW: 3.2 },   // Westin St. Francis tower (1972, tan concrete, 32 fl)
  'way/1091967971': { hide: true }, 'way/1091967972': { hide: true }, 'way/1091967973': { hide: true },   // Westin E-plan parts: modelled via the façade spec mass
};

export class World {
  group = new THREE.Group();
  collision = new CollisionWorld();
  terrain!: Terrain;
  streets!: Streets;
  buildings!: Buildings;
  plaza!: Plaza;
  gis!: GisData;
  streetSpecs: StreetSpec[] = [];
  heroIds = new Set<string>();           // buildings built entirely by hero modules (no massing geometry, no massing collision)
  facades!: FacadeBuilder;
  facadeSpecs: FacadeSpec[] = [];
  detailedIds = new Set<string>();
  storefronts: StorefrontReg[] = [];
  detailRadius = 230;
  streamRadius = 420;   // façade cells farther than this from the viewer are hidden (massing stays)
  overrides: Record<string, BuildingOverride> = {};
  treeSpots: [number, number, number][] = [];
  constructor() { this.group.name = 'world'; }

  async loadData(progress: (msg: string, f: number) => void) {
    progress('elevation', 0.05);
    const elev = await fetchJson(`${BASE}data/elevation.json`);
    progress('gis', 0.15);
    this.gis = await fetchJson(`${BASE}data/gis.json`);
    return elev;
  }

  async build(progress: (msg: string, f: number) => void) {
    const elev = await this.loadData(progress);
    progress('terrain', 0.3);
    this.terrain = new Terrain(elev.samples);
    this.group.add(this.terrain.mesh);
    this.streetSpecs = this.makeStreetSpecs();
    // ground height for walking: sidewalk level except on roadways
    this.collision.terrain = (x, z) => this.terrain.heightAt(x, z) + (this.isRoad(x, z) ? Streets.ROAD_Y : Streets.SIDEWALK_Y);
    progress('streets', 0.45);
    this.streets = new Streets(this.streetSpecs, this.terrain, this.collision);
    this.group.add(this.streets.group);
    progress('plaza', 0.55);
    this.plaza = new Plaza(this.terrain, this.collision);
    this.group.add(this.plaza.group);
    progress('buildings', 0.62);
    // authored façade specs
    try { const idx = await fetchJson(`${BASE}data/facades/index.json`); for (const f of idx.files || []) { try { const arr = await fetchJson(`${BASE}data/facades/${f}`); this.facadeSpecs.push(...arr); } catch (e) { console.warn('facade file failed', f, e); } } } catch { /* no authored specs yet */ }
    const detailIds = new Set<string>();
    const byId = new Map<string, FacadeSpec>();
    const gb = this.gis.buildings;
    for (const sp of this.facadeSpecs) {
      let id = sp.osmId;
      if (!id && sp.address) id = gb.find((b) => (b.address || '').toLowerCase() === sp.address!.toLowerCase())?.osmId;
      if (!id && sp.name) id = gb.find((b) => (b.name || '').toLowerCase() === sp.name!.toLowerCase())?.osmId;
      if (id) {
        const prev = byId.get(id);
        if (prev) { // merge: first authored spec wins, later files contribute extra storefront bays / edges
          prev.storefronts = [...(prev.storefronts || []), ...(sp.storefronts || []).filter((b) => !(prev.storefronts || []).some((q) => q.edge === b.edge && Math.abs(q.from - b.from) < 0.5))];
          for (const e of sp.edges) if (typeof e.edge === 'number' && !prev.edges.some((q) => q.edge === e.edge)) prev.edges.push(e);
        } else { byId.set(id, sp); detailIds.add(id); }
      }
    }
    // auto-detail every street-facing building near the square
    for (const b of gb) { if (Math.hypot(b.centroid[0], b.centroid[1]) < this.detailRadius && !this.heroIds.has(b.osmId)) detailIds.add(b.osmId); }
    for (const p of this.gis.buildingParts) { if ((p.heightM ?? 0) > 40 && Math.hypot(p.centroid[0], p.centroid[1]) < this.detailRadius) detailIds.add(p.osmId); }   // tower parts
    this.detailedIds = detailIds;
    const noGeometry = new Set([...this.heroIds, ...detailIds]);
    this.buildings = new Buildings(this.gis.buildings, this.gis.buildingParts, this.terrain, this.collision, { ...HEIGHT_OVERRIDES, ...this.overrides }, noGeometry, this.gis.plaza?.footprint || null, this.heroIds);
    this.group.add(this.buildings.group);
    progress('façades', 0.68);
    this.facades = new FacadeBuilder(this);
    let n = 0;
    // storefront census → tenants for auto-detailed buildings (address match: street + house number/range)
    let census: any[] = [];
    try { census = await fetchJson(`${BASE}data/storefronts.json`); } catch { /* optional */ }
    const parseAddr = (a: string) => { const m = /^(\d+)(?:\s*[-–]\s*(\d+))?\s+([A-Za-z'.]+)/.exec(a || ''); return m ? { lo: +m[1], hi: +(m[2] || m[1]), street: m[3].replace(/[.']/g, '').toLowerCase() } : null; };
    const tenantsFor = (info: BuildingInfo): { street: string; tenant: any }[] => {
      const b = info.b; const hn = (b.tags['addr:housenumber'] || '').split(/[;,]/).map((x) => x.trim()).filter(Boolean); const street = (b.tags['addr:street'] || info.address || '').replace(/ (Street|Avenue|Lane|St|Ave|Ln)$/i, '').replace(/[.']/g, '').toLowerCase();
      if (!hn.length || !street) return [];
      let lo = Infinity, hi = -Infinity; for (const h of hn) { const m = /^(\d+)(?:-(\d+))?/.exec(h); if (!m) continue; lo = Math.min(lo, +m[1]); hi = Math.max(hi, +(m[2] || m[1])); }
      if (!Number.isFinite(lo)) return [];
      const out: { street: string; tenant: any }[] = [];
      for (const c of census) {
        const pa = parseAddr(c.address); if (!pa || pa.street !== street) continue;
        if (pa.lo < lo || pa.lo > hi) continue;
        if (/unresolved/i.test(c.name) || !c.name) continue;
        out.push({ street, tenant: c });
      }
      return out;
    };
    const streetOfEdge = (a: [number, number], b: [number, number]) => {
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]); if (len < 1) return null;
      const t = [(b[0] - a[0]) / len, (b[1] - a[1]) / len], nn = [t[1], -t[0]]; const mid = [(a[0] + b[0]) / 2 + nn[0] * 8, (a[1] + b[1]) / 2 + nn[1] * 8];
      for (const st of this.streetSpecs) { const d = st.axis === 'ns' ? Math.abs(mid[0] - st.c) : Math.abs(mid[1] - st.c); const along = st.axis === 'ns' ? mid[1] : mid[0]; if (d < st.width / 2 + st.sidewalk + 2 && along > Math.min(st.from, st.to) && along < Math.max(st.from, st.to) && ((st.axis === 'ns') === (Math.abs(nn[0]) > Math.abs(nn[1])))) return st.name.replace(/ (Street|Avenue|Lane)$/, '').replace(/[.']/g, '').toLowerCase(); }
      return null;
    };
    for (const id of detailIds) {
      const info = this.buildings.infos.get(id); if (!info) continue;
      let spec = byId.get(id) ?? autoSpec(info, n++);
      if (spec && !byId.has(id)) {
        // auto spec: attach census tenants along the matching street edge
        const tl = tenantsFor(info);
        if (tl.length) {
          spec = { ...spec, storefronts: [...(spec.storefronts || [])] };
          const fp = info.footprint;
          const byStreet = new Map<string, any[]>(); for (const t of tl) { const arr = byStreet.get(t.street) || []; arr.push(t.tenant); byStreet.set(t.street, arr); }
          for (const [street, list] of byStreet) {
            let best = -1, bestLen = 0;
            for (let i = 0; i < fp.length; i++) { const a = fp[i], bb = fp[(i + 1) % fp.length]; if (streetOfEdge(a, bb) === street) { const l = Math.hypot(bb[0] - a[0], bb[1] - a[1]); if (l > bestLen) { bestLen = l; best = i; } } }
            if (best < 0 || bestLen < 6) continue;
            const pad = 1.0, inner = bestLen - 2 * pad, w = Math.min(9, inner / list.length);
            list.slice(0, Math.max(1, Math.floor(inner / 3.5))).forEach((c, k) => {
              const from = pad + k * (inner / list.length) + (inner / list.length - w) / 2;
              const vacant = /vacant|closed/i.test(c.status || '');
              spec!.storefronts!.push({ edge: best, from, to: from + w, module: vacant ? 'wall' : (w > 6 ? 'storefront_bay_4.0x5.0' : 'storefront_bay_3.0x4.5'), tenant: vacant ? undefined : { name: c.name, brand: logoKey(c.name) || undefined, signType: 'fascia', category: c.category, status: c.status, confidence: c.confidence, address: c.address, illuminated: /hotel|cafe|restaurant|pharmacy|bank/.test(c.category || '') } });
            });
          }
        }
      }
      if (!spec) { this.buildings.addMassing(info); continue; }
      try { this.facades.build(info, spec); } catch (e) { console.warn('facade build failed', info.name || info.id, e); this.buildings.addMassing(info); }
    }
    this.buildings.flushMassing();
    await this.facades.finalize();
    this.storefronts.push(...this.facades.storefronts);
    this.group.add(this.facades.group);
  }

  /** Distance streaming: toggle façade cell meshes by distance to the viewer (call every ~0.5 s). */
  stream(cam: THREE.Vector3) {
    if (!this.facades) return;
    for (const o of this.facades.group.children) {
      const m = /^(facade:|.*\|)/.test(o.name) ? o : null; if (!m) continue;
      const k = o.name.includes('|') ? o.name.split('|')[0].replace('facade:', '') : null; if (!k || k === 'pool') continue;   // cell-keyed meshes + cell-keyed module pools
      const [cx, cz] = k.split(',').map(Number); if (!Number.isFinite(cx)) continue;
      const x = (cx + 0.5) * 130, z = (cz + 0.5) * 130;
      o.visible = Math.hypot(x - cam.x, z - cam.z) < this.streamRadius + 64;
    }
  }
  isSidewalk(x: number, z: number): boolean {
    for (const s of this.streetSpecs) {
      const hw = s.width / 2 + s.sidewalk;
      if (s.axis === 'ns') { if (Math.abs(x - s.c) <= hw && z >= Math.min(s.from, s.to) - hw && z <= Math.max(s.from, s.to) + hw) return true; }
      else if (Math.abs(z - s.c) <= hw && x >= Math.min(s.from, s.to) - hw && x <= Math.max(s.from, s.to) + hw) return true;
    }
    return false;
  }
  isRoad(x: number, z: number): boolean {
    for (const s of this.streetSpecs) {
      const hw = s.width / 2;
      if (s.axis === 'ns') { if (Math.abs(x - s.c) <= hw && z >= Math.min(s.from, s.to) - hw && z <= Math.max(s.from, s.to) + hw) return true; }
      else if (Math.abs(z - s.c) <= hw && x >= Math.min(s.from, s.to) - hw && x <= Math.max(s.from, s.to) + hw) return true;
    }
    return false;
  }

  /** Median centreline coordinate of a named street from OSM ways. */
  private centre(name: string, axis: 'ns' | 'ew'): number {
    const vals: number[] = [];
    for (const w of this.gis.streets) {
      if (w.name !== name || w.area) continue;
      if (!['primary', 'secondary', 'tertiary', 'residential', 'living_street', 'pedestrian', 'unclassified'].includes(w.kind)) continue;
      for (const p of w.points) vals.push(axis === 'ns' ? p[0] : p[1]);
    }
    if (!vals.length) return NaN;
    vals.sort((a, b) => a - b);
    return vals[Math.floor(vals.length / 2)];
  }

  /** Street specifications (widths/lanes from src/data/recon/streets.json research; centrelines from OSM). */
  makeStreetSpecs(): StreetSpec[] {
    const c = (n: string, a: 'ns' | 'ew') => this.centre(n, a);
    const X = { mason: c('Mason Street', 'ns'), powell: c('Powell Street', 'ns'), stockton: c('Stockton Street', 'ns'), grant: c('Grant Avenue', 'ns'), kearny: c('Kearny Street', 'ns'), taylor: c('Taylor Street', 'ns') };
    const Z = { bush: c('Bush Street', 'ew'), sutter: c('Sutter Street', 'ew'), post: c('Post Street', 'ew'), geary: c('Geary Street', 'ew'), ofarrell: c("O'Farrell Street", 'ew'), ellis: c('Ellis Street', 'ew'), maiden: c('Maiden Lane', 'ew') };
    const fix = (v: number, d: number) => (Number.isFinite(v) ? v : d);
    X.mason = fix(X.mason, -220); X.powell = fix(X.powell, -73); X.stockton = fix(X.stockton, 73.5); X.grant = fix(X.grant, 219); X.kearny = fix(X.kearny, 365); X.taylor = fix(X.taylor, -366);
    Z.bush = fix(Z.bush, -262); Z.sutter = fix(Z.sutter, -157); Z.post = fix(Z.post, -52); Z.geary = fix(Z.geary, 52); Z.ofarrell = fix(Z.ofarrell, 157); Z.ellis = fix(Z.ellis, 262); Z.maiden = fix(Z.maiden, 0);
    const S = (o: Partial<StreetSpec> & { name: string; axis: 'ns' | 'ew'; c: number; from: number; to: number; width: number; sidewalk: number }): StreetSpec => ({ lanes: 3, oneway: null, parking: { left: false, right: false }, ...o }) as StreetSpec;
    const N = -420, Sx = 420;
    return [
      // Powell: three character segments
      S({ name: 'Powell Street', axis: 'ns', c: X.powell, from: Z.geary, to: Sx, width: 8.2, sidewalk: 6.4, lanes: 2, cableCar: true, centerLine: 'none', surface: 'brick' }),   // brick-paved transit/taxi block
      S({ name: 'Powell Street', axis: 'ns', c: X.powell, from: Z.post, to: Z.geary, width: 12.9, sidewalk: 4.05, lanes: 4, cableCar: true, transitLane: 'center', centerLine: 'none' }),
      S({ name: 'Powell Street', axis: 'ns', c: X.powell, from: N, to: Z.post, width: 13.0, sidewalk: 4.0, lanes: 4, cableCar: true, transitLane: 'center', centerLine: 'none' }),
      S({ name: 'Stockton Street', axis: 'ns', c: X.stockton, from: N, to: Sx, width: 13.4, sidewalk: 3.75, lanes: 3, oneway: 'S', transitLane: 'min' }),
      S({ name: 'Grant Avenue', axis: 'ns', c: X.grant, from: N, to: Sx, width: 13.4, sidewalk: 3.7, lanes: 2, oneway: 'N', parking: { left: true, right: true } }),
      S({ name: 'Mason Street', axis: 'ns', c: X.mason, from: N, to: Sx, width: 13.4, sidewalk: 3.7, lanes: 2, oneway: 'S', parking: { left: true, right: true } }),
      S({ name: 'Taylor Street', axis: 'ns', c: X.taylor, from: N, to: Sx, width: 13.4, sidewalk: 3.7, lanes: 2, oneway: 'N', parking: { left: true, right: true } }),
      S({ name: 'Kearny Street', axis: 'ns', c: X.kearny, from: N, to: Sx, width: 13.4, sidewalk: 3.7, lanes: 3, oneway: 'N', parking: { left: false, right: true } }),
      S({ name: 'Post Street', axis: 'ew', c: Z.post, from: N, to: Sx, width: 13.3, sidewalk: 3.9, lanes: 3, oneway: 'E', parking: { left: true, right: false } }),
      S({ name: 'Geary Street', axis: 'ew', c: Z.geary, from: N, to: Sx, width: 13.4, sidewalk: 3.95, lanes: 3, oneway: 'W', parking: { left: false, right: true }, transitLane: 'min' }),
      S({ name: 'Sutter Street', axis: 'ew', c: Z.sutter, from: N, to: Sx, width: 13.8, sidewalk: 3.4, lanes: 3, oneway: 'W', parking: { left: true, right: true } }),
      S({ name: "O'Farrell Street", axis: 'ew', c: Z.ofarrell, from: N, to: Sx, width: 13.4, sidewalk: 3.7, lanes: 3, oneway: 'E', parking: { left: false, right: true }, transitLane: 'max' }),
      S({ name: 'Bush Street', axis: 'ew', c: Z.bush, from: N, to: Sx, width: 13.4, sidewalk: 3.4, lanes: 3, oneway: 'W', parking: { left: true, right: true } }),
      S({ name: 'Ellis Street', axis: 'ew', c: Z.ellis, from: N, to: Sx, width: 13.4, sidewalk: 3.7, lanes: 3, oneway: 'W', parking: { left: true, right: true } }),
      S({ name: 'Maiden Lane', axis: 'ew', c: Z.maiden, from: X.stockton, to: X.grant, width: 5.5, sidewalk: 2.5, lanes: 1, oneway: 'E', pedestrian: true }),
    ];
  }
}
