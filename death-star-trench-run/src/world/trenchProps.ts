import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RNG } from '../core/rng';
import { clamp, smoothstep } from '../core/mathx';
import { DS_RADIUS, TRENCH_DEPTH, TRENCH_HALF_WIDTH, trenchToWorld } from '../core/constants';
import * as GK from './greebleKit';

/* =========================================================================
   TRENCH PROPS — every piece of geometry the trench streams.

   LOCAL FRAMES
   ------------
   Everything is authored in the *trench segment frame*:
       +X = lateral (world +Z)          +Y = radial up          +Z = backwards
   so a point (lx, ly, lz) placed on a segment whose centre is at arc-length
   s0 lives at trench coords  s = s0 - lz,  lateral = lx,  up = ly.

   Wall variants are authored for the RIGHT wall with the trench-facing
   surface at x = 0 and the station interior at x > 0; the LEFT wall is the
   same geometry yawed by PI (which also reverses it along z — free variety).
   ========================================================================= */

export const SEG_LEN = 250;
/** how far the raised trench-lip platform reaches outboard of the wall face */
export const LIP_OUT = 96;
/** inner edge of the free-standing surface deck (fixed lateral, no drift) */
export const DECK_INNER = 120;
/** the deck plain sits this far below the trench lip */
export const DECK_STEP = 14;
export const CORRIDOR_HALF = 1250;

/* ------------------------------------------------------------------ utils */

const _eu = new THREE.Euler();
const _mm = new THREE.Matrix4();

export function place(g: THREE.BufferGeometry, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  if (rx || ry || rz) g.applyMatrix4(_mm.makeRotationFromEuler(_eu.set(rx, ry, rz, 'YXZ')));
  if (x || y || z) g.translate(x, y, z);
  return g;
}

export function mergeParts(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const list = parts.filter(Boolean).map((p) => (p.index ? p.toNonIndexed() : p));
  const m = mergeGeometries(list, false);
  if (!m) throw new Error('trenchProps: merge failed');
  m.computeVertexNormals();
  return m;
}

/** box spanning explicit ranges */
export function bx(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, emis = 0, mat = 0) {
  return place(GK.box(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0), emis, mat), (x0 + x1) / 2, Math.min(y0, y1), (z0 + z1) / 2);
}
/** chamfered slab spanning explicit ranges (greebleKit's slab has its base at y=h, so undo that) */
export function sb(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, ch = 0.6, emis = 0, mat = 0) {
  const h = Math.abs(y1 - y0);
  const g = GK.slab(Math.abs(x1 - x0), h, Math.abs(z1 - z0), ch, emis, mat);
  g.translate(0, -h, 0);
  return place(g, (x0 + x1) / 2, Math.min(y0, y1), (z0 + z1) / 2);
}
/** cylinder with its axis along X, spanning x0..x1 */
export function cylX(x0: number, x1: number, r: number, y: number, z: number, seg = 8, emis = 0, mat = 0) {
  const g = GK.cyl(r, Math.abs(x1 - x0), seg, emis, mat);
  g.rotateZ(-Math.PI / 2);
  return place(g, Math.min(x0, x1), y, z);
}
/** cylinder with its axis along Z, spanning z0..z1 */
export function cylZ(z0: number, z1: number, r: number, x: number, y: number, seg = 8, emis = 0, mat = 0) {
  const g = GK.cyl(r, Math.abs(z1 - z0), seg, emis, mat);
  g.rotateX(Math.PI / 2);
  return place(g, x, y, Math.max(z0, z1));
}

/** oriented cylinder between two points */
export function strut(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, r: number, seg = 5, emis = 0, mat = 2) {
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  const L = Math.max(1e-3, Math.hypot(dx, dy, dz));
  const g = GK.cyl(r, L, seg, emis, mat);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(dx / L, dy / L, dz / L));
  g.applyQuaternion(q);
  g.translate(x0, y0, z0);
  return g;
}

function tagArrays(g: THREE.BufferGeometry, emis: number, mat: number) {
  const n = g.attributes.position.count;
  const e = new Float32Array(n); e.fill(emis);
  const m = new Float32Array(n); m.fill(mat);
  g.setAttribute('aEmis', new THREE.BufferAttribute(e, 1));
  g.setAttribute('aMat', new THREE.BufferAttribute(m, 1));
  return g;
}

function soup(pos: number[], uv: number[], emis: number, mat: number): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return tagArrays(g, emis, mat);
}

/** two triangles, wound so the face points along +Y for a corner order of
 *  (x0,z0) (x1,z0) (x1,z1) (x0,z1). */
function quad(pos: number[], uv: number[],
  ax: number, ay: number, az: number, bx_: number, by: number, bz: number,
  cx: number, cy: number, cz: number, dx: number, dy: number, dz: number) {
  pos.push(ax, ay, az, cx, cy, cz, bx_, by, bz, ax, ay, az, dx, dy, dz, cx, cy, cz);
  uv.push(0, 0, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1);
}

/** height of the free deck surface at a given |lateral| (matches the shell sphere at the corridor edge) */
export function deckTopY(lat: number): number {
  const a = Math.min(Math.abs(lat), CORRIDOR_HALF);
  const drop = Math.sqrt(Math.max(0, DS_RADIUS * DS_RADIUS - a * a)) - DS_RADIUS;
  return drop - DECK_STEP * (1 - smoothstep(DECK_INNER, CORRIDOR_HALF, a));
}

/* ==========================================================================
   WALLS
   ========================================================================== */

export interface WallVariant {
  geo: THREE.BufferGeometry;
  /** metres the wall intrudes into the trench at (tz 0..1 along the segment, up) */
  prot(tz: number, up: number): number;
  name: string;
}

const Z0 = -SEG_LEN / 2, Z1 = SEG_LEN / 2;

/** shared shell: backing, top-lip platform, outer skirt, rim rail, lip greebles */
function wallShell(p: THREE.BufferGeometry[], rng: RNG) {
  p.push(bx(0, 40, -134, 0.2, Z0, Z1, 0, 0));                       // structural backing
  // horizontal course lines on the trench face
  const bands = rng.int(3, 6);
  for (let i = 0; i < bands; i++) {
    const y = -6 - ((i + rng.range(0.1, 0.9)) / bands) * 112;
    p.push(bx(-1.6, 1, y, y + rng.range(1.1, 2.8), Z0, Z1, 0, 1));
  }
  // trench-lip platform + skirt down to the deck plain
  p.push(sb(0, LIP_OUT, -3.4, 0, Z0, Z1, 1.2, 0, 0));
  p.push(bx(LIP_OUT - 5, LIP_OUT, -DECK_STEP - 1, 0, Z0, Z1, 0, 1));
  // raised rim rail at the very edge
  p.push(bx(-1.4, 3.4, 0, 2.8, Z0, Z1, 0, 1));
  p.push(bx(-2.0, -1.2, 0.6, 1.5, Z0, Z1, 1, 3));
  // lip machinery so the view from above the trench is not bare
  const n = rng.int(13, 20);
  for (let i = 0; i < n; i++) {
    const x = rng.range(9, LIP_OUT - 14);
    const z = rng.range(Z0 + 8, Z1 - 8);
    const k = rng.next();
    if (k < 0.4) {
      const w = rng.range(5, 16), d = rng.range(5, 20), h = rng.range(2.5, 14);
      p.push(bx(x - w / 2, x + w / 2, 0, h, z - d / 2, z + d / 2, 0, 1));
      if (rng.bool(0.4)) p.push(bx(x - w * 0.3, x + w * 0.3, h, h + 0.4, z - d * 0.3, z + d * 0.3, 1, 3));
    } else if (k < 0.68) {
      const w = rng.range(9, 26), d = rng.range(7, 24);
      p.push(sb(x - w / 2, x + w / 2, 0, rng.range(1, 3.2), z - d / 2, z + d / 2, 0.5, 0, 0));
      if (rng.bool(0.4)) p.push(bx(x - w * 0.22, x + w * 0.22, 0, rng.range(3, 11), z - d * 0.22, z + d * 0.22, 0, 1));
    } else if (k < 0.86) {
      p.push(place(GK.cyl(rng.range(1.4, 4.2), rng.range(4, 18), 8, 0, 2), x, 0, z));
      p.push(place(GK.cyl(rng.range(1.8, 2.6), 1.0, 8, 1, 3), x, rng.range(4, 16), z));
    } else {
      const w = rng.range(6, 16), d = rng.range(5, 12), dep = rng.range(2, 5);
      p.push(bx(x - w / 2, x + w / 2, -dep, -dep + 0.4, z - d / 2, z + d / 2, 0.9, 3));
      p.push(bx(x - w / 2 - 1, x - w / 2, -dep, 0.2, z - d / 2, z + d / 2, 0, 0));
      p.push(bx(x + w / 2, x + w / 2 + 1, -dep, 0.2, z - d / 2, z + d / 2, 0, 0));
      p.push(bx(x - w / 2, x + w / 2, -dep, 0.2, z - d / 2 - 1, z - d / 2, 0, 0));
      p.push(bx(x - w / 2, x + w / 2, -dep, 0.2, z + d / 2, z + d / 2 + 1, 0, 0));
    }
  }
}

/** scatter small hardware over the trench-facing wall surface */
function wallGreebles(p: THREE.BufferGeometry[], rng: RNG, count: number, xAt: (y: number) => number = () => 0) {
  for (let i = 0; i < count; i++) {
    const y = rng.range(-124, -6);
    const z = rng.range(Z0 + 4, Z1 - 4);
    const xFace = xAt(y);
    const k = rng.next();
    if (k < 0.34) {
      const h = rng.range(1.5, 7), d = rng.range(2, 9), o = rng.range(0.8, 2.6);
      p.push(bx(xFace - o, xFace + 2, y, y + h, z - d / 2, z + d / 2, 0, 1));
    } else if (k < 0.56) {
      const h = rng.range(1, 3), d = rng.range(4, 16);
      p.push(bx(xFace - 1.2, xFace + 1, y, y + h, z - d / 2, z + d / 2, 0, 0));
    } else if (k < 0.74) {
      p.push(cylZ(z - rng.range(4, 22), z, rng.range(0.4, 1.3), xFace - rng.range(0.6, 2.2), y, 6, 0, 2));
    } else if (k < 0.88) {
      const h = rng.range(1.2, 3.4), d = rng.range(2.5, 7);
      p.push(bx(xFace - 0.9, xFace + 0.4, y, y + h, z - d / 2, z + d / 2, 1, 3));
    } else {
      p.push(place(GK.cyl(rng.range(0.7, 2.0), rng.range(1, 3.5), 7, 0, 1), xFace - 0.4, y, z, 0, 0, Math.PI / 2));
    }
  }
}

/** a recessed, glowing vent well let into the wall face */
function wallVentWell(p: THREE.BufferGeometry[], rng: RNG, y: number, z: number, w: number, h: number) {
  const dep = rng.range(2.5, 5);
  p.push(bx(dep - 0.4, dep, y, y + h, z - w / 2, z + w / 2, 0.95, 3));
  const bars = Math.max(2, Math.round(h / rng.range(1.2, 2.4)));
  for (let i = 0; i < bars; i++) {
    const by = y + ((i + 0.5) / bars) * h;
    p.push(bx(0.2, dep - 0.6, by - 0.35, by + 0.35, z - w / 2, z + w / 2, 0, 1));
  }
  p.push(bx(-0.6, 0.9, y - 1.2, y + h + 1.2, z - w / 2 - 1.4, z - w / 2, 0, 0));
  p.push(bx(-0.6, 0.9, y - 1.2, y + h + 1.2, z + w / 2, z + w / 2 + 1.4, 0, 0));
  p.push(bx(-0.6, 0.9, y - 1.4, y, z - w / 2 - 1.4, z + w / 2 + 1.4, 0, 0));
  p.push(bx(-0.6, 0.9, y + h, y + h + 1.4, z - w / 2 - 1.4, z + w / 2 + 1.4, 0, 0));
}

type Bumps = { c: number; hw: number; d: number; y0: number; y1: number }[];
function bumpProt(b: Bumps, tz: number, up: number, base: number) {
  let m = base;
  for (let i = 0; i < b.length; i++) {
    const q = b[i];
    if (up < q.y0 || up > q.y1) continue;
    if (Math.abs(tz - q.c) < q.hw && q.d > m) m = q.d;
  }
  return m;
}

/* ---- the eight standard wall profiles ---- */

function wRibs(rng: RNG): WallVariant {
  const p: THREE.BufferGeometry[] = []; wallShell(p, rng);
  const n = rng.int(14, 22);
  const dep = rng.range(2.2, 3.6);
  const top = rng.range(-4, -9), bot = rng.range(-118, -130);
  for (let i = 0; i < n; i++) {
    const z = Z0 + ((i + 0.5) / n) * SEG_LEN;
    const w = rng.range(2.6, 5.4);
    p.push(bx(-dep, 1, top, bot, z - w / 2, z + w / 2, 0, 0));
    p.push(bx(-dep - 0.7, -dep + 0.6, top - 2, top - 5.5, z - w / 2 - 0.4, z + w / 2 + 0.4, 0, 1));
    if (i % 3 === 0) p.push(bx(-dep - 0.5, -dep + 0.2, -30, -34, z - w / 2, z + w / 2, 1, 3));
  }
  // deep horizontal seam
  const sy = rng.range(-45, -75);
  p.push(bx(-0.5, 5.5, sy, sy + rng.range(4, 8), Z0, Z1, 0, 1));
  wallGreebles(p, rng, 26);
  for (let i = 0; i < 3; i++) wallVentWell(p, rng, rng.range(-100, -20), rng.range(Z0 + 20, Z1 - 20), rng.range(5, 11), rng.range(4, 10));
  return { geo: mergeParts(p), prot: () => dep + 0.7, name: 'ribs' };
}

function wBays(rng: RNG): WallVariant {
  const p: THREE.BufferGeometry[] = []; wallShell(p, rng);
  const n = rng.int(3, 5);
  for (let i = 0; i < n; i++) {
    const zc = Z0 + ((i + 0.5) / n) * SEG_LEN;
    const zw = (SEG_LEN / n) * rng.range(0.5, 0.72);
    const y0 = rng.range(-108, -80), y1 = rng.range(-18, -40);
    const dep = rng.range(9, 16);
    // recess box
    p.push(bx(dep - 1.2, dep, y0, y1, zc - zw / 2, zc + zw / 2, 0, 1));
    p.push(bx(0, dep, y0 - 1.4, y0, zc - zw / 2, zc + zw / 2, 0, 0));
    p.push(bx(0, dep, y1, y1 + 1.4, zc - zw / 2, zc + zw / 2, 0, 0));
    p.push(bx(0, dep, y0, y1, zc - zw / 2 - 1.4, zc - zw / 2, 0, 0));
    p.push(bx(0, dep, y0, y1, zc + zw / 2, zc + zw / 2 + 1.4, 0, 0));
    // frame lip
    p.push(bx(-1.6, 0.4, y0 - 2.6, y0 - 1.0, zc - zw / 2 - 2.6, zc + zw / 2 + 2.6, 0, 1));
    p.push(bx(-1.6, 0.4, y1 + 1.0, y1 + 2.6, zc - zw / 2 - 2.6, zc + zw / 2 + 2.6, 0, 1));
    // bay guts
    const g = rng.int(4, 8);
    for (let j = 0; j < g; j++) {
      const by = rng.range(y0 + 2, y1 - 3), bz = rng.range(zc - zw / 2 + 3, zc + zw / 2 - 3);
      const k = rng.next();
      if (k < 0.4) p.push(bx(dep - rng.range(3, 7), dep - 1, by, by + rng.range(2, 8), bz - rng.range(1, 4), bz + rng.range(1, 4), 0, 1));
      else if (k < 0.7) p.push(cylZ(bz - rng.range(5, 20), bz, rng.range(0.5, 1.6), dep - rng.range(1.5, 4), by, 6, 0, 2));
      else p.push(bx(dep - 1.6, dep - 0.9, by, by + rng.range(1.5, 5), bz - rng.range(1, 3), bz + rng.range(1, 3), 1, 3));
    }
    p.push(bx(dep - 1.5, dep - 0.8, y0 + 1, y0 + 1.8, zc - zw / 2 + 1, zc + zw / 2 - 1, 1, 3));
  }
  wallGreebles(p, rng, 30);
  return { geo: mergeParts(p), prot: () => 2.4, name: 'bays' };
}

function wButtress(rng: RNG): WallVariant {
  const p: THREE.BufferGeometry[] = []; wallShell(p, rng);
  const n = rng.int(3, 4);
  const bumps: Bumps = [];
  const dep = rng.range(6, 9.5);
  for (let i = 0; i < n; i++) {
    const zc = Z0 + ((i + 0.5) / n) * SEG_LEN + rng.range(-10, 10);
    const w = rng.range(13, 22);
    // stepped buttress: wide at the bottom, narrow at the top
    p.push(bx(-dep, 2, -132, -70, zc - w / 2, zc + w / 2, 0, 0));
    p.push(bx(-dep * 0.68, 2, -70, -34, zc - w * 0.42, zc + w * 0.42, 0, 0));
    p.push(bx(-dep * 0.4, 2, -34, -2, zc - w * 0.3, zc + w * 0.3, 0, 1));
    p.push(bx(-dep - 0.9, -dep + 0.3, -128, -74, zc - w / 2 - 0.6, zc + w / 2 + 0.6, 0, 1));
    p.push(bx(-dep - 0.6, -dep + 0.1, -100, -96, zc - w / 2, zc + w / 2, 1, 3));
    p.push(bx(-dep - 0.6, -dep + 0.1, -60, -57, zc - w * 0.42, zc + w * 0.42, 1, 3));
    // shoulder pipes
    p.push(cylZ(zc - w * 0.8, zc + w * 0.8, 0.9, -dep * 0.5, -72, 6, 0, 2));
    bumps.push({ c: (zc - Z0) / SEG_LEN, hw: (w / 2 + 1.5) / SEG_LEN, d: dep + 1, y0: -134, y1: -68 });
    bumps.push({ c: (zc - Z0) / SEG_LEN, hw: (w * 0.42 + 1) / SEG_LEN, d: dep * 0.68 + 1, y0: -70, y1: -30 });
  }
  wallGreebles(p, rng, 26);
  for (let i = 0; i < 2; i++) wallVentWell(p, rng, rng.range(-95, -30), rng.range(Z0 + 20, Z1 - 20), rng.range(6, 12), rng.range(5, 12));
  return { geo: mergeParts(p), prot: (tz, up) => bumpProt(bumps, tz, up, 2.2), name: 'buttress' };
}

function wTerrace(rng: RNG): WallVariant {
  const p: THREE.BufferGeometry[] = []; wallShell(p, rng);
  const steps = rng.int(2, 3);
  let d = rng.range(4.5, 7);
  let y = rng.range(-24, -38);
  const maxD: { y0: number; y1: number; d: number }[] = [];
  for (let i = 0; i < steps; i++) {
    const yb = y - rng.range(24, 36);
    p.push(bx(-d, 2, y, yb, Z0, Z1, 0, 0));
    p.push(bx(-d - 1.1, -d + 0.4, y, y - 2.4, Z0, Z1, 0, 1));
    p.push(bx(-d - 0.8, -d + 0.1, y - 2.9, y - 3.6, Z0, Z1, 1, 3));
    // hardware standing on each terrace top
    const n = rng.int(4, 8);
    for (let j = 0; j < n; j++) {
      const z = rng.range(Z0 + 6, Z1 - 6);
      const w = rng.range(2, 6), dd = rng.range(2, 7);
      p.push(bx(-d + 0.3, -d + 0.3 + w, y, y + rng.range(2, 7), z - dd / 2, z + dd / 2, 0, 1));
    }
    maxD.push({ y0: yb, y1: y, d: d + 1.2 });
    y = yb; d += rng.range(2.5, 5);
  }
  p.push(bx(-d, 2, y, -134, Z0, Z1, 0, 0));
  p.push(bx(-d - 1.1, -d + 0.4, y, y - 2.4, Z0, Z1, 0, 1));
  maxD.push({ y0: -134, y1: y, d: d + 1.2 });
  const depthAt = (yy: number) => { for (const m of maxD) if (yy >= m.y0 && yy <= m.y1) return -(m.d - 1.2); return 0; };
  wallGreebles(p, rng, 24, depthAt);
  for (let i = 0; i < 2; i++) wallVentWell(p, rng, rng.range(-30, -12), rng.range(Z0 + 20, Z1 - 20), rng.range(6, 12), rng.range(4, 9));
  return {
    geo: mergeParts(p),
    prot: (_tz, up) => { for (const m of maxD) if (up >= m.y0 && up <= m.y1) return m.d; return 2.2; },
    name: 'terrace',
  };
}

function wChannel(rng: RNG): WallVariant {
  const p: THREE.BufferGeometry[] = []; wallShell(p, rng);
  const cy0 = rng.range(-84, -60), ch = rng.range(20, 32);
  const dep = rng.range(11, 17);
  p.push(bx(dep - 1.2, dep, cy0, cy0 + ch, Z0, Z1, 0, 1));
  p.push(bx(0, dep, cy0 - 2, cy0, Z0, Z1, 0, 0));
  p.push(bx(0, dep, cy0 + ch, cy0 + ch + 2, Z0, Z1, 0, 0));
  p.push(bx(-2.4, 0.6, cy0 - 3.4, cy0 - 1.4, Z0, Z1, 0, 1));
  p.push(bx(-2.4, 0.6, cy0 + ch + 1.4, cy0 + ch + 3.4, Z0, Z1, 0, 1));
  // service run inside the channel
  const pipes = rng.int(3, 6);
  for (let i = 0; i < pipes; i++) {
    p.push(cylZ(Z0 - 2, Z1 + 2, rng.range(0.6, 1.8), dep - rng.range(1.5, 6), cy0 + rng.range(3, ch - 3), 7, 0, 2));
  }
  const n = rng.int(8, 14);
  for (let i = 0; i < n; i++) {
    const z = Z0 + ((i + 0.5) / n) * SEG_LEN;
    p.push(bx(0.5, dep, cy0 + 1, cy0 + ch - 1, z - 1.1, z + 1.1, 0, 0));
    if (rng.bool(0.5)) p.push(bx(dep - 2.2, dep - 1.4, cy0 + rng.range(2, ch - 5), cy0 + rng.range(5, ch - 2), z - 2.6, z + 2.6, 1, 3));
  }
  // heavy plating above and below the channel
  for (let i = 0; i < 10; i++) {
    const y = rng.bool() ? rng.range(cy0 + ch + 5, -10) : rng.range(-128, cy0 - 6);
    const z = rng.range(Z0 + 8, Z1 - 8);
    p.push(sb(-rng.range(1.5, 3.5), 0.5, y, y + rng.range(6, 18), z - rng.range(6, 20), z + rng.range(6, 20), 0.5, 0, 0));
  }
  wallGreebles(p, rng, 24);
  return { geo: mergeParts(p), prot: () => 3.6, name: 'channel' };
}

function wGantry(rng: RNG): WallVariant {
  const p: THREE.BufferGeometry[] = []; wallShell(p, rng);
  const gy = rng.range(-52, -30);
  const gd = rng.range(8, 12);
  p.push(sb(-gd, 1, gy, gy + 2.2, Z0, Z1, 0.5, 0, 0));
  p.push(bx(-gd - 0.9, -gd + 0.3, gy, gy + 0.9, Z0, Z1, 1, 3));
  // railing + struts
  const n = 14;
  for (let i = 0; i <= n; i++) {
    const z = Z0 + (i / n) * SEG_LEN;
    p.push(bx(-gd + 0.3, -gd + 1.1, gy + 2.2, gy + 5.2, z - 0.45, z + 0.45, 0, 2));
    p.push(strut(0.5, gy - 13, z, -gd + 1.5, gy - 0.3, z, 0.7, 5));
  }
  p.push(bx(-gd + 0.2, -gd + 0.8, gy + 4.6, gy + 5.2, Z0, Z1, 0, 2));
  // machinery standing on the gantry
  const m = rng.int(4, 7);
  for (let i = 0; i < m; i++) {
    const z = rng.range(Z0 + 8, Z1 - 8);
    const w = rng.range(2.5, 6), d = rng.range(3, 10);
    p.push(bx(-gd + 1.5, -gd + 1.5 + w, gy + 2.2, gy + 2.2 + rng.range(3, 10), z - d / 2, z + d / 2, 0, 1));
    if (rng.bool(0.5)) p.push(bx(-gd + 1.5, -gd + 1.5 + w, gy + 2.2, gy + 2.6, z - d / 2, z + d / 2, 1, 3));
  }
  // large flush panels elsewhere
  for (let i = 0; i < 10; i++) {
    const y = rng.bool() ? rng.range(gy + 12, -8) : rng.range(-126, gy - 10);
    const z = rng.range(Z0 + 10, Z1 - 10);
    p.push(sb(-rng.range(1.2, 3), 0.5, y, y + rng.range(8, 22), z - rng.range(8, 22), z + rng.range(8, 22), 0.6, 0, 0));
  }
  wallGreebles(p, rng, 22);
  for (let i = 0; i < 2; i++) wallVentWell(p, rng, rng.range(-118, gy - 14), rng.range(Z0 + 20, Z1 - 20), rng.range(6, 12), rng.range(5, 12));
  return {
    geo: mergeParts(p),
    prot: (_tz, up) => (up > gy - 2 && up < gy + 6 ? gd + 1.4 : 2.4),
    name: 'gantry',
  };
}

function wPanels(rng: RNG): WallVariant {
  const p: THREE.BufferGeometry[] = []; wallShell(p, rng);
  const cols = rng.int(4, 7), rows = rng.int(4, 7);
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const z0 = Z0 + (i / cols) * SEG_LEN + 1.5, z1 = Z0 + ((i + 1) / cols) * SEG_LEN - 1.5;
      const y0 = -130 + (j / rows) * 126 + 1.5, y1 = -130 + ((j + 1) / rows) * 126 - 1.5;
      const k = rng.next();
      if (k < 0.35) {
        const pr = rng.range(2.5, 6.5);
        p.push(sb(-pr, 0.4, y0, y1, z0, z1, 0.7, 0, 0));
        p.push(bx(-pr - 1.2, -pr + 0.3, y0 + 1, y0 + 2.6, z0, z1, 0, 1));
        p.push(bx(-pr - 1.2, -pr + 0.3, y1 - 2.6, y1 - 1, z0, z1, 0, 1));
        if (rng.bool(0.35)) p.push(bx(-pr - 0.9, -pr + 0.2, (y0 + y1) / 2 - 0.7, (y0 + y1) / 2 + 0.7, z0 + 2, z1 - 2, 1, 3));
      } else if (k < 0.55) {
        const d = rng.range(4, 9);
        p.push(bx(d - 0.5, d, y0, y1, z0, z1, k < 0.44 ? 0.85 : 0, k < 0.44 ? 3 : 1));
        p.push(bx(-0.6, d, y0 - 1, y0, z0, z1, 0, 0));
        p.push(bx(-0.6, d, y1, y1 + 1, z0, z1, 0, 0));
        p.push(bx(-0.6, d, y0, y1, z0 - 1, z0, 0, 0));
        p.push(bx(-0.6, d, y0, y1, z1, z1 + 1, 0, 0));
      } else if (k < 0.72) {
        const gy = rng.int(3, 7);
        for (let g = 0; g < gy; g++) {
          const yy = y0 + ((g + 0.5) / gy) * (y1 - y0);
          p.push(bx(-1.1, 0.3, yy - 0.7, yy + 0.7, z0 + 1, z1 - 1, 0, 1));
        }
        p.push(bx(0.2, 1.2, y0, y1, z0, z1, 0, 1));
      } else {
        p.push(sb(-rng.range(2.2, 4), 0.4, y0 + 2, y1 - 2, z0 + 2, z1 - 2, 0.6, 0, 1));
        if (rng.bool(0.4)) p.push(bx(-rng.range(2.4, 4.2), -1.6, (y0 + y1) / 2 - 0.8, (y0 + y1) / 2 + 0.8, z0 + 3, z1 - 3, 1, 3));
      }
    }
  }
  wallGreebles(p, rng, 26);
  for (let i = 0; i < 3; i++) wallVentWell(p, rng, rng.range(-110, -20), rng.range(Z0 + 20, Z1 - 20), rng.range(5, 10), rng.range(4, 9));
  return { geo: mergeParts(p), prot: () => 7.6, name: 'panels' };
}

function wHeavy(rng: RNG): WallVariant {
  const p: THREE.BufferGeometry[] = []; wallShell(p, rng);
  const bumps: Bumps = [];
  const n = rng.int(4, 7);
  for (let i = 0; i < n; i++) {
    const zc = rng.range(Z0 + 22, Z1 - 22);
    const w = rng.range(16, 34), h = rng.range(16, 40);
    const y = rng.range(-118, -34);
    const d = rng.range(5.5, 11);
    p.push(sb(-d, 1.5, y, y + h, zc - w / 2, zc + w / 2, 1.0, 0, 0));
    p.push(bx(-d - 1.2, -d + 0.5, y + 1, y + 3.2, zc - w / 2 - 0.8, zc + w / 2 + 0.8, 0, 1));
    p.push(bx(-d - 1.2, -d + 0.5, y + h - 3.2, y + h - 1, zc - w / 2 - 0.8, zc + w / 2 + 0.8, 0, 1));
    p.push(bx(-d - 0.9, -d + 0.2, y + h * 0.5 - 0.8, y + h * 0.5 + 0.8, zc - w / 2 + 2, zc + w / 2 - 2, 1, 3));
    const g = rng.int(3, 6);
    for (let j = 0; j < g; j++) {
      const gz = rng.range(zc - w / 2 + 3, zc + w / 2 - 3);
      const gy = rng.range(y + 2, y + h - 4);
      if (rng.bool(0.5)) p.push(place(GK.cyl(rng.range(0.8, 2.2), rng.range(2, 6), 8, 0, 2), -d - 0.2, gy, gz, 0, 0, Math.PI / 2));
      else p.push(bx(-d - rng.range(1.5, 4), -d, gy, gy + rng.range(2, 6), gz - rng.range(1, 3), gz + rng.range(1, 3), 0, 1));
    }
    bumps.push({ c: (zc - Z0) / SEG_LEN, hw: (w / 2 + 4) / SEG_LEN, d: d + 4.2, y0: y - 2, y1: y + h + 2 });
  }
  // long pipe runs skimming the wall
  for (let i = 0; i < 3; i++) {
    const y = rng.range(-124, -10);
    p.push(cylZ(Z0 - 2, Z1 + 2, rng.range(0.9, 2.2), -rng.range(1.5, 3.5), y, 8, 0, 2));
    for (let j = 0; j < 6; j++) {
      const z = Z0 + ((j + 0.5) / 6) * SEG_LEN;
      p.push(bx(-4.2, 0.5, y - 2.4, y + 2.4, z - 1.1, z + 1.1, 0, 1));
    }
  }
  wallGreebles(p, rng, 22);
  return { geo: mergeParts(p), prot: (tz, up) => bumpProt(bumps, tz, up, 3.4), name: 'heavy' };
}

/** the monumental "you are almost there" wall used in the last 2 km */
export function buildApproachWall(seed: number): WallVariant {
  const rng = new RNG(seed);
  const p: THREE.BufferGeometry[] = []; wallShell(p, rng);
  const n = 5;
  for (let i = 0; i < n; i++) {
    const zc = Z0 + ((i + 0.5) / n) * SEG_LEN;
    const w = 26;
    // colossal pylon
    p.push(sb(-9, 2, -134, -6, zc - w / 2, zc + w / 2, 1.4, 0, 0));
    p.push(bx(-10.4, -8, -128, -14, zc - w / 2 - 1, zc + w / 2 + 1, 0, 1));
    p.push(bx(-10.2, -8.4, -120, -114, zc - w / 2, zc + w / 2, 1, 3));
    p.push(bx(-10.2, -8.4, -76, -70, zc - w / 2, zc + w / 2, 1, 3));
    p.push(bx(-10.2, -8.4, -32, -26, zc - w / 2, zc + w / 2, 1, 3));
    // floodlight head angled down into the trench
    p.push(bx(-14, -8, -14, -6, zc - 4, zc + 4, 0, 1));
    p.push(bx(-14.6, -13.4, -13, -7, zc - 3.2, zc + 3.2, 1, 3));
    // between-pylon recess with a lit grid
    const zg0 = zc + w / 2 + 3, zg1 = zc + SEG_LEN / n - w / 2 - 3;
    if (zg1 > zg0) {
      p.push(bx(4.4, 5, -120, -14, zg0, zg1, 0.9, 3));
      for (let g = 0; g < 9; g++) {
        const yy = -120 + ((g + 0.5) / 9) * 106;
        p.push(bx(0, 4.6, yy - 1.4, yy + 1.4, zg0, zg1, 0, 1));
      }
    }
  }
  wallGreebles(p, rng, 20);
  return { geo: mergeParts(p), prot: () => 11, name: 'approach' };
}

export function buildWallVariants(seed: number): WallVariant[] {
  const builders = [wRibs, wBays, wButtress, wTerrace, wChannel, wGantry, wPanels, wHeavy];
  return builders.map((b, i) => b(new RNG(seed + i * 7919)));
}

/* ==========================================================================
   FLOORS
   ========================================================================== */

export interface FloorVariant {
  geo: THREE.BufferGeometry;
  /** how far the plating stands proud of the nominal floor at (tz, lateral) */
  rise(tz: number, lat: number): number;
  name: string;
}

const FX = 96;   // floor tiles reach this far laterally (walls always cover the edge)

function floorBase(p: THREE.BufferGeometry[], _rng: RNG) {
  p.push(bx(-FX, FX, -9, 0, Z0, Z1, 0, 0));
}

/** relief shared by every floor variant: two deep longitudinal channels plus
 *  transverse ribs. Both give strong perspective/rhythm cues at 430 m/s. */
function floorCommon(p: THREE.BufferGeometry[], rng: RNG) {
  const off = rng.range(-16, 16);
  const gauge = rng.range(30, 62);
  for (const sgn of [-1, 1]) {
    const x = off + sgn * gauge / 2;
    const w = rng.range(5, 11);
    const dep = rng.range(3.2, 6.0);
    p.push(bx(x - w / 2, x + w / 2, -dep, -dep + 0.6, Z0, Z1, 0, 1));         // channel floor
    p.push(bx(x - w / 2 - 1.8, x - w / 2, -dep, 0.4, Z0, Z1, 0, 0));          // channel walls
    p.push(bx(x + w / 2, x + w / 2 + 1.8, -dep, 0.4, Z0, Z1, 0, 0));
    p.push(bx(x - 1.0, x + 1.0, -dep + 0.6, -dep + 1.0, Z0, Z1, 1, 3));       // lit trace at the bottom
    const n = Math.round(SEG_LEN / rng.range(9, 16));
    for (let i = 0; i < n; i++) {
      const z = Z0 + ((i + 0.5) / n) * SEG_LEN;
      p.push(bx(x - w / 2 - 0.6, x + w / 2 + 0.6, -dep + 0.6, -dep + rng.range(1.6, 2.8), z - 1.5, z + 1.5, 0, 2));
    }
  }
  // transverse ribs across the full width — the floor's "ticking"
  const nr = Math.round(SEG_LEN / rng.range(11, 19));
  const rh = rng.range(0.7, 1.6);
  for (let i = 0; i < nr; i++) {
    const z = Z0 + ((i + 0.5) / nr) * SEG_LEN;
    p.push(bx(-FX, FX, 0, rh, z - rng.range(1.2, 2.6), z + rng.range(1.2, 2.6), 0, 1));
    if (i % 3 === 0) {
      p.push(bx(-FX + 6, -FX + 16, 0, rh + 0.5, z - 3, z + 3, 0, 1));
      p.push(bx(FX - 16, FX - 6, 0, rh + 0.5, z - 3, z + 3, 0, 1));
    }
  }
}

function floorEdgeLights(p: THREE.BufferGeometry[], rng: RNG) {
  for (const s of [-1, 1]) {
    const x = s * rng.range(50, 64);
    p.push(bx(x - 2.2, x + 2.2, 0, 1.1, Z0, Z1, 0, 1));
    p.push(bx(x - 0.9, x + 0.9, 1.1, 1.5, Z0, Z1, 1, 3));
  }
}

function fPlated(rng: RNG): FloorVariant {
  const p: THREE.BufferGeometry[] = []; floorBase(p, rng);
  const cols = rng.int(5, 8), rows = rng.int(4, 7);
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const z0 = Z0 + (i / cols) * SEG_LEN + 1.2, z1 = Z0 + ((i + 1) / cols) * SEG_LEN - 1.2;
      const x0 = -FX + (j / rows) * FX * 2 + 1.2, x1 = -FX + ((j + 1) / rows) * FX * 2 - 1.2;
      const k = rng.next();
      if (k < 0.5) p.push(sb(x0, x1, 0, rng.range(0.5, 1.6), z0, z1, 0.5, 0, 0));
      else if (k < 0.72) { p.push(bx(x0, x1, -2.2, -1.6, z0, z1, rng.bool(0.35) ? 0.8 : 0, 3)); }
      else p.push(sb(x0 + 2, x1 - 2, 0, rng.range(1.5, 3.4), z0 + 2, z1 - 2, 0.6, 0, 1));
    }
  }
  // longitudinal recessed channels
  for (let i = 0; i < 2; i++) {
    const x = rng.range(-70, 70);
    p.push(bx(x - 4, x + 4, -3.4, -2.8, Z0, Z1, 0, 1));
    for (let j = 0; j < 16; j++) {
      const z = Z0 + ((j + 0.5) / 16) * SEG_LEN;
      p.push(bx(x - 4.2, x + 4.2, -2.6, -1.9, z - 1.4, z + 1.4, 0, 2));
    }
  }
  floorCommon(p, rng);
  floorEdgeLights(p, rng);
  return { geo: mergeParts(p), rise: () => 2.4, name: 'plated' };
}

function fChannels(rng: RNG): FloorVariant {
  const p: THREE.BufferGeometry[] = []; floorBase(p, rng);
  const n = rng.int(3, 5);
  for (let i = 0; i < n; i++) {
    const x = -70 + ((i + 0.5) / n) * 140 + rng.range(-8, 8);
    const w = rng.range(7, 15);
    const dep = rng.range(2.5, 5);
    p.push(bx(x - w / 2, x + w / 2, -dep, -dep + 0.5, Z0, Z1, 0, 1));
    p.push(bx(x - w / 2 - 1.6, x - w / 2, -dep, 0.3, Z0, Z1, 0, 0));
    p.push(bx(x + w / 2, x + w / 2 + 1.6, -dep, 0.3, Z0, Z1, 0, 0));
    const k = rng.next();
    if (k < 0.4) {
      p.push(cylZ(Z0 - 2, Z1 + 2, rng.range(0.9, 2.2), x, -dep + 1.8, 8, 0, 2));
    } else if (k < 0.7) {
      for (let j = 0; j < 22; j++) {
        const z = Z0 + ((j + 0.5) / 22) * SEG_LEN;
        p.push(bx(x - w / 2 + 0.6, x + w / 2 - 0.6, -dep + 0.5, -dep + 1.2, z - 2.4, z + 2.4, 0, 1));
      }
    } else {
      p.push(bx(x - w / 2 + 1, x + w / 2 - 1, -dep + 0.4, -dep + 0.8, Z0, Z1, 0.9, 3));
    }
  }
  // cross ribs
  for (let j = 0; j < 10; j++) {
    const z = Z0 + ((j + 0.5) / 10) * SEG_LEN;
    p.push(bx(-FX, FX, 0, rng.range(0.6, 1.5), z - rng.range(1.5, 4), z + rng.range(1.5, 4), 0, 1));
  }
  floorCommon(p, rng);
  floorEdgeLights(p, rng);
  return { geo: mergeParts(p), rise: () => 2.4, name: 'channels' };
}

function fGrates(rng: RNG): FloorVariant {
  const p: THREE.BufferGeometry[] = []; floorBase(p, rng);
  const zones = rng.int(2, 4);
  for (let i = 0; i < zones; i++) {
    const zc = Z0 + ((i + 0.5) / zones) * SEG_LEN;
    const zw = (SEG_LEN / zones) * rng.range(0.55, 0.85);
    const xw = rng.range(30, 80);
    const xc = rng.range(-30, 30);
    p.push(bx(xc - xw / 2, xc + xw / 2, -4.2, -3.6, zc - zw / 2, zc + zw / 2, 0.9, 3));
    const bars = Math.round(zw / rng.range(3.5, 6));
    for (let j = 0; j < bars; j++) {
      const z = zc - zw / 2 + ((j + 0.5) / bars) * zw;
      p.push(bx(xc - xw / 2, xc + xw / 2, -1.6, -0.4, z - 0.9, z + 0.9, 0, 2));
    }
    p.push(bx(xc - xw / 2 - 2, xc - xw / 2, -4.2, 0.6, zc - zw / 2 - 2, zc + zw / 2 + 2, 0, 0));
    p.push(bx(xc + xw / 2, xc + xw / 2 + 2, -4.2, 0.6, zc - zw / 2 - 2, zc + zw / 2 + 2, 0, 0));
    p.push(bx(xc - xw / 2, xc + xw / 2, -4.2, 0.6, zc - zw / 2 - 2, zc - zw / 2, 0, 0));
    p.push(bx(xc - xw / 2, xc + xw / 2, -4.2, 0.6, zc + zw / 2, zc + zw / 2 + 2, 0, 0));
  }
  for (let i = 0; i < 10; i++) {
    const x = rng.range(-FX + 6, FX - 6), z = rng.range(Z0 + 6, Z1 - 6);
    p.push(sb(x - rng.range(3, 10), x + rng.range(3, 10), 0, rng.range(0.8, 2.6), z - rng.range(3, 10), z + rng.range(3, 10), 0.5, 0, 0));
  }
  floorCommon(p, rng);
  floorEdgeLights(p, rng);
  return { geo: mergeParts(p), rise: () => 2.4, name: 'grates' };
}

function fIslands(rng: RNG): FloorVariant {
  const p: THREE.BufferGeometry[] = []; floorBase(p, rng);
  const islands: { x: number; z: number; xw: number; zw: number; h: number }[] = [];
  const n = rng.int(2, 4);
  for (let i = 0; i < n; i++) {
    const x = (rng.bool() ? 1 : -1) * rng.range(30, 74);
    const z = Z0 + ((i + 0.5) / n) * SEG_LEN + rng.range(-20, 20);
    const xw = rng.range(16, 34), zw = rng.range(20, 55), h = rng.range(5, 16);
    p.push(sb(x - xw / 2, x + xw / 2, 0, h, z - zw / 2, z + zw / 2, 1.0, 0, 0));
    p.push(bx(x - xw / 2 - 0.8, x + xw / 2 + 0.8, h * 0.15, h * 0.15 + 0.7, z - zw / 2 - 0.8, z + zw / 2 + 0.8, 1, 3));
    const g = rng.int(3, 7);
    for (let j = 0; j < g; j++) {
      const gx = rng.range(x - xw * 0.35, x + xw * 0.35), gz = rng.range(z - zw * 0.4, z + zw * 0.4);
      const k = rng.next();
      if (k < 0.4) p.push(bx(gx - rng.range(1, 4), gx + rng.range(1, 4), h, h + rng.range(2, 9), gz - rng.range(1, 4), gz + rng.range(1, 4), 0, 1));
      else if (k < 0.75) p.push(place(GK.cyl(rng.range(1, 3), rng.range(2, 8), 8, 0, 2), gx, h, gz));
      else p.push(bx(gx - 2.5, gx + 2.5, h, h + 0.4, gz - 2.5, gz + 2.5, 1, 3));
    }
    islands.push({ x, z, xw: xw / 2 + 3, zw: zw / 2 + 3, h: h + 1 });
  }
  // pipe runs along the length
  for (let i = 0; i < 3; i++) {
    const x = rng.range(-80, 80), y = rng.range(1.5, 4);
    p.push(cylZ(Z0 - 2, Z1 + 2, rng.range(0.7, 1.8), x, y, 7, 0, 2));
    for (let j = 0; j < 7; j++) {
      const z = Z0 + ((j + 0.5) / 7) * SEG_LEN;
      p.push(bx(x - 2.2, x + 2.2, 0, y + 0.6, z - 1.1, z + 1.1, 0, 1));
    }
  }
  floorCommon(p, rng);
  floorEdgeLights(p, rng);
  return {
    geo: mergeParts(p),
    rise: (tz, lat) => {
      const z = Z0 + tz * SEG_LEN;
      for (const i of islands) if (Math.abs(lat - i.x) < i.xw && Math.abs(z - i.z) < i.zw) return i.h;
      return 2.4;
    },
    name: 'islands',
  };
}

function fRails(rng: RNG): FloorVariant {
  const p: THREE.BufferGeometry[] = []; floorBase(p, rng);
  const gauge = rng.range(26, 52);
  const off = rng.range(-24, 24);
  for (const s of [-1, 1]) {
    const x = off + s * gauge / 2;
    p.push(bx(x - 1.6, x + 1.6, 0, 2.4, Z0, Z1, 0, 2));
    p.push(bx(x - 2.6, x + 2.6, 2.4, 3.0, Z0, Z1, 0, 1));
  }
  for (let j = 0; j < 26; j++) {
    const z = Z0 + ((j + 0.5) / 26) * SEG_LEN;
    p.push(bx(off - gauge / 2 - 5, off + gauge / 2 + 5, 0, 1.0, z - 1.7, z + 1.7, 0, 1));
  }
  p.push(bx(off - 1.2, off + 1.2, -2.4, -1.8, Z0, Z1, 0.9, 3));
  // outboard hardware strips
  for (let i = 0; i < 12; i++) {
    const x = (rng.bool() ? 1 : -1) * rng.range(34, 88);
    const z = rng.range(Z0 + 8, Z1 - 8);
    const k = rng.next();
    if (k < 0.5) p.push(sb(x - rng.range(4, 12), x + rng.range(4, 12), 0, rng.range(1, 3.4), z - rng.range(5, 18), z + rng.range(5, 18), 0.5, 0, 0));
    else if (k < 0.8) p.push(bx(x - 3, x + 3, 0, rng.range(2, 7), z - rng.range(2, 7), z + rng.range(2, 7), 0, 1));
    else p.push(bx(x - 4, x + 4, -2.4, -1.9, z - 6, z + 6, 1, 3));
  }
  floorCommon(p, rng);
  floorEdgeLights(p, rng);
  return { geo: mergeParts(p), rise: () => 3.6, name: 'rails' };
}

export function buildFloorVariants(seed: number): FloorVariant[] {
  const builders = [fPlated, fChannels, fGrates, fIslands, fRails];
  return builders.map((b, i) => b(new RNG(seed + i * 104729)));
}

/** floor tile with the exhaust shaft punched through it (dz = local z of the port centre) */
export function buildPortFloor(seed: number, portDz: number, holeR: number): FloorVariant {
  const rng = new RNG(seed);
  const p: THREE.BufferGeometry[] = [];
  const nx = 26, nz = 34;
  const pos: number[] = [], uv: number[] = [];
  const dx = (FX * 2) / nx, dz = SEG_LEN / nz;
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      const ax = -FX + i * dx, bx2 = ax + dx, az = Z0 + j * dz, bz = az + dz;
      const cx = (ax + bx2) / 2, cz = (az + bz) / 2;
      if (Math.hypot(cx, cz - portDz) < holeR) continue;
      quad(pos, uv, ax, 0, az, bx2, 0, az, bx2, 0, bz, ax, 0, bz);
      quad(pos, uv, ax, -9, bz, bx2, -9, bz, bx2, -9, az, ax, -9, az);
    }
  }
  p.push(soup(pos, uv, 0, 0));
  // heavy radial plating outboard of the emplacement disc
  for (let i = 0; i < 20; i++) {
    const a = (i / 20) * Math.PI * 2;
    const r0 = PORT_PLATFORM_R + rng.range(3, 12), r1 = r0 + rng.range(10, 30);
    const rm = (r0 + r1) / 2;
    const cz = portDz + Math.cos(a) * rm, cx = Math.sin(a) * rm;
    if (cz < Z0 + 4 || cz > Z1 - 4 || Math.abs(cx) > FX - 12) continue;
    const g = bx(-rng.range(2.5, 6), rng.range(2.5, 6), 0, rng.range(0.5, 1.4), r0, r1, 0, i % 3 === 0 ? 1 : 0);
    p.push(place(g, 0, 0, portDz, 0, a, 0));
  }
  // fore/aft approach lights converging on the port
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 + 0.31;
    const rr = PORT_PLATFORM_R + 16;
    const cz = portDz + Math.cos(a) * rr, cx = Math.sin(a) * rr;
    if (cz < Z0 + 6 || cz > Z1 - 6 || Math.abs(cx) > 44) continue;
    p.push(place(bx(-2.4, 2.4, 0, 8, rr - 2.4, rr + 2.4, 0, 1), 0, 0, portDz, 0, a, 0));
    p.push(place(bx(-1.8, 1.8, 5.2, 7.6, rr - 3.0, rr - 2.2, 1, 3), 0, 0, portDz, 0, a, 0));
  }
  floorEdgeLights(p, rng);
  return {
    geo: mergeParts(p),
    rise: (tz, lat) => {
      const z = Z0 + tz * SEG_LEN;
      return Math.max(2.0, portRise(Math.hypot(lat, z - portDz)));
    },
    name: 'port',
  };
}

/* ==========================================================================
   SURFACE DECK (|lat| 180 .. 1250)
   ========================================================================== */

type Rect = { x0: number; x1: number; z0: number; z1: number };

function deckGrid(x0: number, x1: number, z0: number, z1: number, nx: number, nz: number, holes: Rect[]): THREE.BufferGeometry {
  const pos: number[] = [], uv: number[] = [];
  const dx = (x1 - x0) / nx, dz = (z1 - z0) / nz;
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      const ax = x0 + i * dx, bxx = ax + dx, az = z0 + j * dz, bz = az + dz;
      const cx = (ax + bxx) / 2, cz = (az + bz) / 2;
      let skip = false;
      for (const h of holes) if (cx > h.x0 && cx < h.x1 && cz > h.z0 && cz < h.z1) { skip = true; break; }
      if (skip) continue;
      const ya = deckTopY(ax), yb = deckTopY(bxx);
      quad(pos, uv, ax, ya, az, bxx, yb, az, bxx, yb, bz, ax, ya, bz);
    }
  }
  return soup(pos, uv, 0, 0);
}

/** shallow secondary trench cut into the deck */
function deckCut(p: THREE.BufferGeometry[], rng: RNG, r: Rect) {
  const y = deckTopY((r.x0 + r.x1) / 2);
  const dep = rng.range(9, 20);
  p.push(bx(r.x0, r.x1, y - dep, y - dep + 1.2, r.z0, r.z1, 0, 1));
  p.push(bx(r.x0 - 2.5, r.x0, y - dep, y + 1, r.z0 - 2.5, r.z1 + 2.5, 0, 0));
  p.push(bx(r.x1, r.x1 + 2.5, y - dep, y + 1, r.z0 - 2.5, r.z1 + 2.5, 0, 0));
  p.push(bx(r.x0 - 2.5, r.x1 + 2.5, y - dep, y + 1, r.z0 - 2.5, r.z0, 0, 0));
  p.push(bx(r.x0 - 2.5, r.x1 + 2.5, y - dep, y + 1, r.z1, r.z1 + 2.5, 0, 0));
  const long = (r.z1 - r.z0) > (r.x1 - r.x0);
  const n = Math.max(3, Math.round((long ? r.z1 - r.z0 : r.x1 - r.x0) / rng.range(18, 40)));
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    if (long) {
      const z = r.z0 + t * (r.z1 - r.z0);
      p.push(bx(r.x0, r.x1, y - dep + 1.2, y - dep + rng.range(3, 7), z - 2, z + 2, 0, 1));
      if (rng.bool(0.4)) p.push(bx(r.x0 + 1, r.x1 - 1, y - 2.4, y - 1.6, z - 5, z + 5, 1, 3));
    } else {
      const x = r.x0 + t * (r.x1 - r.x0);
      p.push(bx(x - 2, x + 2, y - dep + 1.2, y - dep + rng.range(3, 7), r.z0, r.z1, 0, 1));
    }
  }
  p.push(bx(r.x0 - 1.2, r.x0 + 0.4, y, y + 0.9, r.z0, r.z1, 1, 3));
  p.push(bx(r.x1 - 0.4, r.x1 + 1.2, y, y + 0.9, r.z0, r.z1, 1, 3));
}

/**
 * One deck tile covering lateral x0..x1 and length `len` along z.
 * `density` scales how much hardware sits on it (near tiles are denser).
 */
function deckTile(rng: RNG, x0: number, x1: number, len: number, nx: number, nz: number, density: number): THREE.BufferGeometry {
  const z0 = -len / 2, z1 = len / 2;
  const p: THREE.BufferGeometry[] = [];
  const holes: Rect[] = [];
  const cuts: Rect[] = [];
  // parallel secondary trenches
  const npar = rng.int(1, 3);
  for (let i = 0; i < npar; i++) {
    const w = rng.range(24, 60);
    const cx = rng.range(x0 + w, x1 - w);
    const r = { x0: cx - w / 2, x1: cx + w / 2, z0: z0 - 1, z1: z1 + 1 };
    holes.push({ x0: r.x0 - 2.5, x1: r.x1 + 2.5, z0: r.z0 - 3, z1: r.z1 + 3 });
    cuts.push(r);
  }
  // perpendicular secondary trench
  if (rng.bool(0.65)) {
    const w = rng.range(20, 48);
    const cz = rng.range(z0 + w, z1 - w);
    const r = { x0: x0 - 1, x1: x1 + 1, z0: cz - w / 2, z1: cz + w / 2 };
    holes.push({ x0: r.x0 - 3, x1: r.x1 + 3, z0: r.z0 - 2.5, z1: r.z1 + 2.5 });
    cuts.push(r);
  }
  p.push(deckGrid(x0, x1, z0, z1, nx, nz, holes));
  for (const c of cuts) deckCut(p, rng, c);

  // plating, big blocks, recessed bays
  const n = Math.round(density * rng.range(14, 22));
  for (let i = 0; i < n; i++) {
    const cx = rng.range(x0 + 12, x1 - 12), cz = rng.range(z0 + 12, z1 - 12);
    let inHole = false;
    for (const h of holes) if (cx > h.x0 - 20 && cx < h.x1 + 20 && cz > h.z0 - 20 && cz < h.z1 + 20) { inHole = true; break; }
    if (inHole) continue;
    const y = deckTopY(cx);
    const sc = 1 + (Math.abs(cx) / CORRIDOR_HALF) * 3.2;
    const k = rng.next();
    if (k < 0.4) {
      const w = rng.range(14, 44) * sc, d = rng.range(14, 50) * sc;
      p.push(sb(cx - w / 2, cx + w / 2, y, y + rng.range(1.2, 4) * sc, cz - d / 2, cz + d / 2, 0.8, 0, 0));
    } else if (k < 0.66) {
      const w = rng.range(10, 30) * sc, d = rng.range(10, 34) * sc, h = rng.range(5, 22) * sc;
      p.push(sb(cx - w / 2, cx + w / 2, y, y + h, cz - d / 2, cz + d / 2, 1.2, 0, 0));
      p.push(bx(cx - w / 2 - 1, cx + w / 2 + 1, y + h * 0.12, y + h * 0.12 + 0.8 * sc, cz - d / 2 - 1, cz + d / 2 + 1, 1, 3));
      p.push(bx(cx - w * 0.3, cx + w * 0.3, y + h, y + h + rng.range(2, 8) * sc, cz - d * 0.3, cz + d * 0.3, 0, 1));
    } else if (k < 0.84) {
      const w = rng.range(16, 40) * sc, d = rng.range(16, 40) * sc, dep = rng.range(4, 12) * sc;
      p.push(bx(cx - w / 2, cx + w / 2, y - dep, y - dep + 0.7, cz - d / 2, cz + d / 2, 0.85, 3));
      p.push(bx(cx - w / 2 - 2, cx - w / 2, y - dep, y + 0.6, cz - d / 2 - 2, cz + d / 2 + 2, 0, 0));
      p.push(bx(cx + w / 2, cx + w / 2 + 2, y - dep, y + 0.6, cz - d / 2 - 2, cz + d / 2 + 2, 0, 0));
      p.push(bx(cx - w / 2, cx + w / 2, y - dep, y + 0.6, cz - d / 2 - 2, cz - d / 2, 0, 0));
      p.push(bx(cx - w / 2, cx + w / 2, y - dep, y + 0.6, cz + d / 2, cz + d / 2 + 2, 0, 0));
    } else {
      const r = rng.range(3, 9) * sc, h = rng.range(6, 26) * sc;
      p.push(place(GK.taperedCyl(r, r * rng.range(0.5, 0.9), h, 8, 0, 2), cx, y, cz));
      p.push(place(GK.cyl(r * 1.3, 1.2 * sc, 8, 1, 3), cx, y + h, cz));
    }
  }
  return mergeParts(p);
}

export interface DeckSet { near: THREE.BufferGeometry[]; mid: THREE.BufferGeometry[]; far: THREE.BufferGeometry[]; }
export function buildDeckTiles(seed: number): DeckSet {
  const near: THREE.BufferGeometry[] = [], mid: THREE.BufferGeometry[] = [], far: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) near.push(deckTile(new RNG(seed + i * 3301), DECK_INNER, 430, SEG_LEN, 7, 8, 1.4));
  for (let i = 0; i < 2; i++) mid.push(deckTile(new RNG(seed + 900 + i * 3301), 430, 820, SEG_LEN * 2, 6, 10, 1.15));
  for (let i = 0; i < 2; i++) far.push(deckTile(new RNG(seed + 1800 + i * 3301), 820, CORRIDOR_HALF, SEG_LEN * 4, 6, 12, 0.95));
  return { near, mid, far };
}

/** big silhouette hardware scattered over the deck — instanced separately */
export function buildDeckGreebles(seed: number): THREE.BufferGeometry[] {
  return GK.greebleAtlas(seed, 6, ['tower', 'machinery', 'antenna', 'plate', 'vent', 'recess'], 2.4);
}

/* ==========================================================================
   OVERHEAD SPANS + IN-TRENCH OBSTACLES
   ========================================================================== */

/** spans are authored crossing the trench along X, centred on x = 0 */
export function buildSpans(seed: number): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const span = 190;
  for (let v = 0; v < 4; v++) {
    const rng = new RNG(seed + v * 7717);
    const p: THREE.BufferGeometry[] = [];
    if (v === 0) {
      // heavy deck bridge
      const g = GK.bridge(rng, span, 1.9);
      g.rotateY(Math.PI / 2);
      p.push(g);
      for (let i = 0; i < 6; i++) {
        const x = -span / 2 + ((i + 0.5) / 6) * span;
        p.push(bx(x - 3, x + 3, 3.5, rng.range(6, 13), -2.5, 2.5, 0, 1));
      }
      p.push(bx(-span / 2, span / 2, -3.4, -2.6, -1.0, 1.0, 1, 3));
    } else if (v === 1) {
      // fat pipe bundle
      const nr = rng.int(3, 5);
      for (let i = 0; i < nr; i++) {
        const r = rng.range(1.6, 3.6);
        const y = rng.range(-2, 4), z = rng.range(-5, 5);
        p.push(cylX(-span / 2, span / 2, r, y, z, 9, 0, 2));
        for (let j = 0; j < 9; j++) {
          const x = -span / 2 + ((j + 0.5) / 9) * span;
          p.push(bx(x - 1.2, x + 1.2, y - r - 1, y + r + 1, z - r - 1, z + r + 1, 0, 1));
        }
      }
      p.push(bx(-span / 2, span / 2, -3, -2.2, -0.8, 0.8, 1, 3));
      p.push(sb(-span / 2, -span / 2 + 16, -8, 8, -9, 9, 1.0, 0, 0));
      p.push(sb(span / 2 - 16, span / 2, -8, 8, -9, 9, 1.0, 0, 0));
    } else if (v === 3) {
      // slim structural rib — reads as a strobing bar overhead at speed
      p.push(bx(-span / 2, span / 2, 0, 3.6, -3.2, 3.2, 0, 0));
      p.push(bx(-span / 2, span / 2, 3.6, 5.0, -4.4, 4.4, 0, 1));
      p.push(bx(-span / 2, span / 2, -0.9, -0.35, -1.1, 1.1, 1, 3));
      for (let i = 0; i < 12; i++) {
        const x = -span / 2 + ((i + 0.5) / 12) * span;
        p.push(bx(x - 1.6, x + 1.6, -2.6, 0, -2.6, 2.6, 0, 1));
      }
      for (const sx of [-1, 1]) {
        const x = sx * (span / 2 - 7);
        p.push(bx(x - 7, x + 7, -9, 7, -6, 6, 0, 0));
        p.push(bx(x - 5, x + 5, 7, 9.4, -7, 7, 0, 1));
      }
    } else {
      // gantry arch with side towers
      p.push(sb(-span / 2, span / 2, 0, 4.2, -7, 7, 1.0, 0, 0));
      p.push(bx(-span / 2, span / 2, 4.2, 5.6, -8, -6.2, 0, 1));
      p.push(bx(-span / 2, span / 2, 4.2, 5.6, 6.2, 8, 0, 1));
      p.push(bx(-span / 2, span / 2, -1.0, -0.2, -6, 6, 1, 3));
      for (let i = 0; i < 10; i++) {
        const x = -span / 2 + ((i + 0.5) / 10) * span;
        const t = GK.cyl(0.7, 13, 5, 0, 2); t.rotateZ(Math.PI * (i % 2 ? 0.4 : -0.4));
        p.push(place(t, x, -7, 0));
      }
      for (const sx of [-1, 1]) {
        const x = sx * (span / 2 - 9);
        p.push(sb(x - 9, x + 9, -6, 22, -11, 11, 1.4, 0, 0));
        p.push(bx(x - 4, x + 4, 22, 30, -4, 4, 0, 1));
        p.push(bx(x - 5, x + 5, 19, 20.4, -12, 12, 1, 3));
      }
    }
    out.push(mergeParts(p));
  }
  return out;
}

export interface PropSet {
  bulkhead: THREE.BufferGeometry;
  cables: THREE.BufferGeometry;
  pylon: THREE.BufferGeometry;
  bracket: THREE.BufferGeometry;
  flood: THREE.BufferGeometry;
}

/** static in-trench obstacles. Authored around the origin; +X points into the trench. */
export function buildStaticProps(seed: number): PropSet {
  const rng = new RNG(seed);

  // partial bulkhead: grows from x=0 (wall face) inward to x=+W
  const bp: THREE.BufferGeometry[] = [];
  {
    const W = 74;
    bp.push(sb(0, W, -110, -4, -5, 5, 1.4, 0, 0));
    bp.push(bx(W - 4, W + 1.5, -110, -4, -6.5, 6.5, 0, 1));
    bp.push(bx(W - 3.2, W - 1.4, -104, -10, -7, 7, 1, 3));
    for (let i = 0; i < 8; i++) {
      const y = -108 + ((i + 0.5) / 8) * 100;
      bp.push(bx(2, W - 6, y - 1.6, y + 1.6, -6.5, 6.5, 0, 1));
    }
    for (let i = 0; i < 10; i++) {
      const x = rng.range(4, W - 8), y = rng.range(-104, -10);
      bp.push(bx(x, x + rng.range(3, 10), y, y + rng.range(3, 12), -7.5, -5, 0, 1));
      if (rng.bool(0.4)) bp.push(bx(x + 1, x + 4, y + 1, y + 3, -8.2, -7.4, 1, 3));
    }
    bp.push(bx(0, 8, -112, -2, -8, 8, 0, 0));
  }

  // hanging cable bundle — droops from the top of the trench
  const cp: THREE.BufferGeometry[] = [];
  {
    cp.push(bx(-9, 9, -3, 1, -4, 4, 0, 0));
    const n = rng.int(5, 9);
    for (let i = 0; i < n; i++) {
      const x = rng.range(-7, 7), z = rng.range(-3, 3);
      const len = rng.range(20, 62);
      const segs = 5;
      let px = x, py = -3, pz = z;
      for (let j = 0; j < segs; j++) {
        const t = (j + 1) / segs;
        const nx2 = x + Math.sin(t * 2.1 + i) * 3.5 * t;
        const ny = -3 - len * t;
        const nz = z + Math.cos(t * 1.7 + i) * 2.5 * t;
        const dx = nx2 - px, dy = ny - py, dz = nz - pz;
        const L = Math.hypot(dx, dy, dz);
        const g = GK.cyl(rng.range(0.28, 0.7), L, 5, 0, 2);
        const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(dx / L, dy / L, dz / L));
        g.applyQuaternion(q); g.translate(px, py, pz);
        cp.push(g);
        px = nx2; py = ny; pz = nz;
      }
      cp.push(place(GK.cyl(0.9, 1.2, 6, 1, 3), px, py - 1.2, pz));
    }
  }

  // free-standing pylon on the trench floor
  const pp: THREE.BufferGeometry[] = [];
  {
    const h = 58;
    pp.push(sb(-7, 7, 0, h, -7, 7, 1.4, 0, 0));
    pp.push(bx(-9, 9, 0, 3, -9, 9, 0, 1));
    pp.push(bx(-8, 8, h * 0.4, h * 0.4 + 1.2, -8, 8, 1, 3));
    pp.push(bx(-5, 5, h, h + 10, -5, 5, 0, 1));
    pp.push(bx(-6, 6, h + 10, h + 11.2, -6, 6, 1, 3));
    for (let i = 0; i < 8; i++) {
      const y = rng.range(4, h - 6);
      const a = rng.range(0, Math.PI * 2);
      const g = bx(6.5, 6.5 + rng.range(2, 6), y, y + rng.range(2, 7), -3, 3, 0, 1);
      pp.push(place(g, 0, 0, 0, 0, a, 0));
    }
  }

  // wall bracket that carries a turret
  const kp: THREE.BufferGeometry[] = [];
  {
    kp.push(sb(-1, 15, -3.5, 0, -11, 11, 0.9, 0, 0));
    kp.push(bx(-1, 4, -14, -3.5, -9, 9, 0, 1));
    const t1 = GK.cyl(1.1, 17, 6, 0, 2); t1.rotateZ(Math.PI * 0.35);
    kp.push(place(t1, 1, -13, -7));
    const t2 = GK.cyl(1.1, 17, 6, 0, 2); t2.rotateZ(Math.PI * 0.35);
    kp.push(place(t2, 1, -13, 7));
    kp.push(bx(13.6, 15.2, -3.2, -2.4, -10, 10, 1, 3));
  }

  // floodlight tower for the port approach
  const fp: THREE.BufferGeometry[] = [];
  {
    fp.push(sb(-5, 5, 0, 40, -5, 5, 1.0, 0, 0));
    fp.push(bx(-7, 7, 0, 4, -7, 7, 0, 1));
    for (let i = 0; i < 3; i++) {
      const y = 30 + i * 4;
      fp.push(bx(-9, 9, y, y + 2.6, -3.2, 3.2, 0, 1));
      fp.push(bx(-8.4, 8.4, y + 0.4, y + 2.2, -3.6, -3.0, 1, 3));
    }
    fp.push(bx(-2, 2, 40, 46, -2, 2, 0, 2));
    fp.push(bx(-3.2, 3.2, 46, 47.4, -3.2, 3.2, 1, 3));
  }

  return {
    bulkhead: mergeParts(bp),
    cables: mergeParts(cp),
    pylon: mergeParts(pp),
    bracket: mergeParts(kp),
    flood: mergeParts(fp),
  };
}

export interface AnimSet {
  fan: THREE.BufferGeometry;      // spin axis = local +Z
  housing: THREE.BufferGeometry;  // static ring around the fan
  piston: THREE.BufferGeometry;   // rod pointing +X
  door: THREE.BufferGeometry;     // leaf, grows from x=0 toward +X
}

export function buildAnimProps(seed: number): AnimSet {
  const rng = new RNG(seed);

  const fp: THREE.BufferGeometry[] = [];
  {
    const R = 13, blades = 7;
    fp.push(place(GK.cyl(3.2, 5, 10, 0, 1), 0, -2.5, 0, Math.PI / 2, 0, 0));
    for (let i = 0; i < blades; i++) {
      const a = (i / blades) * Math.PI * 2;
      const g = bx(-1.0, 1.0, 3, R, -2.6, 2.6, 0, 1);
      g.applyMatrix4(new THREE.Matrix4().makeRotationY(0.42));
      fp.push(place(g, 0, 0, 0, 0, 0, a));
    }
    fp.push(place(GK.cyl(2.2, 1.6, 8, 1, 3), 0, 2.4, 0, Math.PI / 2, 0, 0));
  }

  const hp: THREE.BufferGeometry[] = [];
  {
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const g = bx(-2.4, 2.4, 14, 18.5, -4.5, 4.5, 0, 0);
      hp.push(place(g, 0, 0, 0, 0, 0, a));
    }
    hp.push(place(GK.cyl(18.5, 3, 20, 0, 1), 0, -6.5, 0, Math.PI / 2, 0, 0));
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.3;
      const g = bx(-1.2, 1.2, 15.5, 17.5, -6.4, -5.6, 1, 3);
      hp.push(place(g, 0, 0, 0, 0, 0, a));
    }
  }

  const pp: THREE.BufferGeometry[] = [];
  {
    pp.push(cylX(0, 34, 2.0, 0, 0, 10, 0, 2));
    pp.push(cylX(30, 40, 3.6, 0, 0, 10, 0, 1));
    pp.push(bx(38, 42, -5, 5, -5, 5, 0, 1));
    pp.push(bx(41.2, 42.2, -3.6, 3.6, -3.6, 3.6, 1, 3));
  }

  const dp: THREE.BufferGeometry[] = [];
  {
    const W = 66;
    dp.push(sb(0, W, -104, -6, -3.5, 3.5, 1.2, 0, 0));
    dp.push(bx(W - 3, W + 1, -104, -6, -5, 5, 0, 1));
    dp.push(bx(W - 2.4, W - 1.2, -100, -10, -5.4, 5.4, 1, 3));
    for (let i = 0; i < 6; i++) {
      const x = ((i + 0.5) / 6) * W;
      dp.push(bx(x - 4, x + 4, -102, -8, -4.6, -3.2, 0, 1));
    }
    for (let i = 0; i < 5; i++) {
      const y = -100 + ((i + 0.5) / 5) * 92;
      dp.push(bx(3, W - 5, y - 2.2, y + 2.2, -4.4, -3.0, 0, 1));
    }
  }

  return { fan: mergeParts(fp), housing: mergeParts(hp), piston: mergeParts(pp), door: mergeParts(dp) };
}

/* ==========================================================================
   TURRETS
   ========================================================================== */

export interface TurretGeo {
  base: THREE.BufferGeometry; head: THREE.BufferGeometry; barrels: THREE.BufferGeometry;
  /** local +Y of the head pivot above the base, and of the barrel pivot above that */
  headY: number; barrelY: number;
  /** local z of the barrel tips (barrels fire along -Z) */
  muzzleZ: number;
}
export function buildTurretGeo(seed: number, scale = 2.2): TurretGeo {
  const rng = new RNG(seed);
  const base = GK.turretBase(rng, scale);
  const head = GK.turretHead(rng, scale);
  // greebleKit's slab primitive sits one height above its origin; re-centre the housing
  head.translate(0, -2.2 * scale, 0);
  const barrels = GK.turretBarrels(new RNG(seed + 17), scale);
  barrels.computeBoundingBox();
  const muzzleZ = barrels.boundingBox ? barrels.boundingBox.min.z : -9 * scale;
  return { base, head, barrels, headY: 1.95 * scale, barrelY: 1.6 * scale, muzzleZ };
}

/* ==========================================================================
   EXHAUST PORT
   ========================================================================== */

export interface PortGeo {
  hull: THREE.BufferGeometry;
  dark: THREE.BufferGeometry;
  glow: THREE.BufferGeometry;
  depth: number;
}

/** open-ended cone/ring section, axis +Y, from (rBottom, y0) to (rTop, y1) */
function ring(rB: number, rT: number, y0: number, y1: number, seg: number, emis: number, mat: number, invert = false) {
  const g = new THREE.CylinderGeometry(rT, rB, Math.abs(y1 - y0), seg, 1, true);
  g.translate(0, (y0 + y1) / 2, 0);
  if (invert) g.scale(-1, 1, 1);
  return tagArrays(g.toNonIndexed(), emis, mat);
}

export function buildPort(seed: number, portR: number): PortGeo {
  const rng = new RNG(seed);
  const hull: THREE.BufferGeometry[] = [];
  const dark: THREE.BufferGeometry[] = [];
  const glow: THREE.BufferGeometry[] = [];

  const SHAFT = 210;
  const SEGN = 44;
  const PLAT_R = 52;            // the whole emplacement disc
  const PLAT_Y = 3.2;
  const CROWN_R = portR + 19;   // 30
  const CROWN_Y = 11.5;
  const RIM_R = portR + 3.2;

  const annulus = (r0: number, r1: number, y: number, emis = 0, mat = 0) => {
    const g = new THREE.RingGeometry(r0, r1, SEGN, 1);
    g.rotateX(-Math.PI / 2); g.translate(0, y, 0);
    return tagArrays(g.toNonIndexed(), emis, mat);
  };

  /* ---- the disc: platform -> crown -> rim -> mouth ------------------ */
  hull.push(ring(PLAT_R, PLAT_R, PLAT_Y, -1.0, SEGN, 0, 1));                   // outer wall of the platform
  hull.push(annulus(PLAT_R - 8, PLAT_R, PLAT_Y));                              // flat outer apron
  hull.push(ring(PLAT_R - 8, CROWN_R, PLAT_Y, CROWN_Y, SEGN, 0, 0));           // sloped armour flank
  hull.push(annulus(RIM_R, CROWN_R, CROWN_Y));                                 // crown top
  hull.push(ring(RIM_R, RIM_R, CROWN_Y, CROWN_Y + 2.0, SEGN, 0, 1));           // raised rim
  hull.push(annulus(portR, RIM_R, CROWN_Y + 2.0, 0, 1));                       // rim top
  hull.push(ring(portR, portR, CROWN_Y + 2.0, CROWN_Y - 2.2, SEGN, 0, 1, true)); // mouth chamfer (inward)

  // radial armour segments across the crown
  const plates = 26;
  for (let i = 0; i < plates; i++) {
    const a = (i / plates) * Math.PI * 2;
    const w = rng.range(1.5, 3.0);
    hull.push(place(bx(-w, w, CROWN_Y, CROWN_Y + rng.range(0.7, 1.9), RIM_R + 0.6, CROWN_R - rng.range(0.5, 5), 0, i % 4 === 0 ? 1 : 0), 0, 0, 0, 0, a, 0));
    if (i % 2 === 0) hull.push(place(bx(-w * 0.5, w * 0.5, CROWN_Y, CROWN_Y + 0.5, CROWN_R - 6, CROWN_R - 1.5, 1, 3), 0, 0, 0, 0, a, 0));
  }

  /* ---- 6 radial buttresses spanning crown to apron ------------------ */
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.26;
    hull.push(place(sb(-6, 6, PLAT_Y - 1, CROWN_Y + 3.5, CROWN_R - 5, PLAT_R + 1, 1.4, 0, 0), 0, 0, 0, 0, a, 0));
    hull.push(place(bx(-7.2, 7.2, PLAT_Y + 1.2, PLAT_Y + 3.0, CROWN_R - 3, PLAT_R + 1.6, 0, 1), 0, 0, 0, 0, a, 0));
    hull.push(place(bx(-3.2, 3.2, CROWN_Y + 3.5, CROWN_Y + 7.5, CROWN_R - 3, CROWN_R + 9, 0, 1), 0, 0, 0, 0, a, 0));
    hull.push(place(bx(-2.3, 2.3, CROWN_Y + 7.5, CROWN_Y + 8.4, CROWN_R - 1, CROWN_R + 7, 1, 3), 0, 0, 0, 0, a, 0));
    hull.push(place(strut(0, CROWN_Y + 3.5, CROWN_R - 2, 0, PLAT_Y + 2, PLAT_R - 2, 1.2, 6), 0, 0, 0, 0, a, 0));
  }

  /* ---- 4 marker pylons — what you pick up from 2 km out ------------- */
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const rr = PLAT_R - 5;
    hull.push(place(sb(-4.4, 4.4, PLAT_Y - 1, PLAT_Y + 26, rr - 4.4, rr + 4.4, 1.0, 0, 0), 0, 0, 0, 0, a, 0));
    hull.push(place(bx(-5.8, 5.8, PLAT_Y + 2, PLAT_Y + 5, rr - 5.8, rr + 5.8, 0, 1), 0, 0, 0, 0, a, 0));
    hull.push(place(bx(-3.2, 3.2, PLAT_Y + 26, PLAT_Y + 30, rr - 3.2, rr + 3.2, 1, 3), 0, 0, 0, 0, a, 0));
    const q = new THREE.SphereGeometry(3.5, 12, 8);
    q.translate(0, PLAT_Y + 31.4, rr);
    q.applyMatrix4(new THREE.Matrix4().makeRotationY(a));
    hull.push(tagArrays(q.toNonIndexed(), 1, 3));
  }

  /* ---- floodlights on the apron, angled at the mouth ---------------- */
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.52;
    const rr = PLAT_R - 6;
    hull.push(place(bx(-2.6, 2.6, PLAT_Y, PLAT_Y + 12, rr - 2.6, rr + 2.6, 0, 1), 0, 0, 0, 0, a, 0));
    hull.push(place(bx(-4.4, 4.4, PLAT_Y + 12, PLAT_Y + 17, rr - 4.6, rr - 0.4, 0, 0), 0, 0, 0, 0, a, 0));
    hull.push(place(bx(-3.6, 3.6, PLAT_Y + 12.8, PLAT_Y + 16.2, rr - 5.0, rr - 4.3, 1, 3), 0, 0, 0, 0, a, 0));
  }

  /* ---- the shaft --------------------------------------------------- */
  dark.push(ring(portR, portR, CROWN_Y - 2.2, -SHAFT, SEGN, 0, 1, true));
  for (let i = 0; i < 12; i++) {
    const y = -4 - i * (SHAFT - 16) / 12;
    dark.push(ring(portR - 1.7, portR - 1.7, y, y - 2.6, SEGN, 0, 0, true));
    for (let j = 0; j < 8; j++) {
      const a = (j / 8) * Math.PI * 2 + i * 0.21;
      dark.push(place(bx(-1.3, 1.3, y - 4.0, y - (SHAFT - 16) / 12 + 1.2, portR - 3.6, portR - 0.7, 0, 1), 0, 0, 0, 0, a, 0));
    }
  }
  dark.push(place(GK.cyl(portR - 0.4, 2, SEGN, 0, 1), 0, -SHAFT, 0));

  /* ---- additive throat glow ---------------------------------------- */
  glow.push(ring(portR - 0.6, portR - 0.6, -1.0, -SHAFT + 6, SEGN, 1, 3, true));
  for (let i = 0; i < 7; i++) {
    const y = -8 - i * 24;
    glow.push(ring(portR - 2.0, portR - 2.0, y, y - 3.4, SEGN, 1, 3, true));
  }
  // shallow discs so the mouth reads as a lit hole from any approach angle
  for (const y of [-17, -38, -66]) {
    const c = new THREE.CircleGeometry(portR - 0.9, SEGN);
    c.rotateX(-Math.PI / 2); c.translate(0, y, 0);
    glow.push(tagArrays(c.toNonIndexed(), 1, 3));
  }
  for (let i = 0; i < 4; i++) {
    const c = new THREE.CircleGeometry(portR - 1.6, SEGN);
    c.rotateX(-Math.PI / 2); c.translate(0, -SHAFT * (0.45 + i * 0.17), 0);
    glow.push(tagArrays(c.toNonIndexed(), 1, 3));
  }

  return { hull: mergeParts(hull), dark: mergeParts(dark), glow: mergeParts(glow), depth: SHAFT };
}

/** height of the exhaust-port emplacement above the trench floor at radius r */
export const PORT_PLATFORM_R = 53;
export function portRise(r: number): number {
  if (r > PORT_PLATFORM_R) return 0;
  if (r > 44) return 4.4;
  if (r > 30) return 13.0;
  return 15.0;
}

/* ==========================================================================
   TERMINATORS + LOW-COST CORRIDOR FILLER
   ========================================================================== */

/** massive bulkhead that caps the ends of the run so the corridor never just stops */
export function buildEndCap(seed: number): THREE.BufferGeometry {
  const rng = new RNG(seed);
  const p: THREE.BufferGeometry[] = [];
  p.push(sb(-95, 95, -112, 6, -14, 0, 2.0, 0, 0));
  p.push(bx(-95, 95, -112, 6, -18, -14, 0, 1));
  for (let i = 0; i < 9; i++) {
    const y = -108 + ((i + 0.5) / 9) * 108;
    p.push(bx(-92, 92, y - 2.4, y + 2.4, -20, -17, 0, 1));
  }
  for (let i = 0; i < 6; i++) {
    const x = -90 + ((i + 0.5) / 6) * 180;
    p.push(bx(x - 6, x + 6, -110, 4, -21, -18, 0, 0));
    p.push(bx(x - 4, x + 4, -60, -52, -22, -20.2, 1, 3));
  }
  for (let i = 0; i < 14; i++) {
    const x = rng.range(-88, 88), y = rng.range(-106, -6);
    p.push(bx(x - rng.range(2, 8), x + rng.range(2, 8), y, y + rng.range(3, 14), -24, -20, 0, 1));
  }
  p.push(bx(-95, 95, 6, 26, -18, 0, 0, 0));
  p.push(bx(-95, 95, 26, 28, -20, 2, 0, 1));
  return mergeParts(p);
}

/**
 * A very cheap always-present shell for the whole corridor so that no matter
 * where the camera is there is never a hole through to the void. It sits
 * just outside/below the streamed detail so it is normally invisible.
 */
export function buildFiller(s0: number, s1: number): THREE.BufferGeometry {
  const pos: number[] = [], uv: number[] = [];
  const N = Math.ceil((s1 - s0) / 500);
  const LAT_W = 82, FLOOR = -124, LIP = -5;
  const bands = [DECK_INNER, 400, 700, 1000, CORRIDOR_HALF];
  const v = new THREE.Vector3();
  const P = (s: number, lat: number, up: number) => { trenchToWorld(s, lat, up, v); return [v.x, v.y, v.z] as const; };
  type P3 = readonly [number, number, number];
  const both = (a: P3, b: P3, c: P3, d: P3) => {
    quad(pos, uv, a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], d[0], d[1], d[2]);
    quad(pos, uv, a[0], a[1], a[2], d[0], d[1], d[2], c[0], c[1], c[2], b[0], b[1], b[2]);
  };
  for (let i = 0; i < N; i++) {
    const a = s0 + (i / N) * (s1 - s0), b = s0 + ((i + 1) / N) * (s1 - s0);
    both(P(a, -LAT_W, FLOOR), P(b, -LAT_W, FLOOR), P(b, LAT_W, FLOOR), P(a, LAT_W, FLOOR));
    for (const s of [-1, 1]) {
      both(P(a, s * LAT_W, FLOOR), P(a, s * LAT_W, LIP), P(b, s * LAT_W, LIP), P(b, s * LAT_W, FLOOR));
      let prev = s * LAT_W, prevY = LIP;
      for (const bnd of bands) {
        const cur = s * bnd, curY = bnd <= DECK_INNER ? LIP : deckTopY(bnd) - 3;
        both(P(a, prev, prevY), P(b, prev, prevY), P(b, cur, curY), P(a, cur, curY));
        prev = cur; prevY = curY;
      }
    }
  }
  return soup(pos, uv, 0, 0);
}

/* ==========================================================================
   LIGHT / GLOW GEOMETRY (additive materials)
   ========================================================================== */

/** long emissive bar running along z, uv.x = distance along the bar in metres */
export function barGeo(len: number, w: number, h: number): THREE.BufferGeometry {
  const pos: number[] = [], uv: number[] = [];
  const z0 = -len / 2, z1 = len / 2;
  const push = (ax: number, ay: number, bx2: number, by: number) => {
    pos.push(ax, ay, z0, bx2, by, z0, bx2, by, z1, ax, ay, z0, bx2, by, z1, ax, ay, z1);
    uv.push(0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1);
  };
  // vertical fin, horizontal fin, and a wide soft blade
  push(-w, 0, w, 0);
  push(0, -h, 0, h);
  push(-w * 3.2, h * 0.6, w * 3.2, h * 0.6);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const u2: number[] = [];
  for (let i = 0; i < pos.length / 3; i++) u2.push(pos[i * 3 + 2] - z0, 0);
  g.setAttribute('uv', new THREE.Float32BufferAttribute(u2, 2));
  g.computeVertexNormals();
  return g;
}

/** small camera-facing-ish beacon blob */
export function beaconGeo(r: number): THREE.BufferGeometry {
  const g = new THREE.OctahedronGeometry(r, 0).toNonIndexed();
  if (!g.attributes.uv) {
    const n = g.attributes.position.count;
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
  }
  return g;
}

/** flat quad in the XY plane used for vent heat-shimmer */
export function glowQuad(w: number, h: number): THREE.BufferGeometry {
  return new THREE.PlaneGeometry(w, h);
}
