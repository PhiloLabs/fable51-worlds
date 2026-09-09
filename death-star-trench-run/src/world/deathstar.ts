import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  DS_RADIUS, DS_DISH_DIR, DISH_RADIUS,
  EQUATOR_TRENCH_HALF, MERIDIAN_CORRIDOR_HALF,
  MERIDIAN_CORRIDOR_S0, MERIDIAN_CORRIDOR_S1,
  inMeridianCorridor, inEquatorTrench, inDishCrater,
} from '../core/constants';
import { RNG, hash3 } from '../core/rng';
import { clamp, smoothstep } from '../core/mathx';
import { createSurfaceMaterial, setSurfaceUniform } from '../shaders/surface';
import {
  greebleAtlas, box, slab, cyl, taperedCyl, machinery, tower, antenna, vent, radiusOf,
} from './greebleKit';

/* =========================================================================
   DEATH STAR — 100 km battle station.

   Macro : cube-sphere shell (6 x 160 x 160 cells, ~300k tris, 1 draw call)
           with the three contract holes cut out and welded shut by
           purpose-built geometry (equatorial trench, superlaser crater);
           the meridian corridor hole is left open for the trench module.
   Meso  : 6 hand-placed macro features (bays, arrays, secondary dish...).
   Micro : streamed InstancedMesh greebles on a cube-face lattice under the
           camera, 3 LOD rings, rebuilt only when the ground cell changes.
   ========================================================================= */

export interface DeathStar {
  group: THREE.Group;
  shell: THREE.Mesh;
  materials: THREE.Material[];
  update(dt: number, time: number, camera: THREE.Camera): void;
  setDamage(v: number): void;
  setVisible(v: boolean): void;
  dispose(): void;
}

/* ------------------------------------------------------------------ noise */

function vnoise3(x: number, y: number, z: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy), uz = fz * fz * (3 - 2 * fz);
  const c000 = hash3(ix, iy, iz), c100 = hash3(ix + 1, iy, iz);
  const c010 = hash3(ix, iy + 1, iz), c110 = hash3(ix + 1, iy + 1, iz);
  const c001 = hash3(ix, iy, iz + 1), c101 = hash3(ix + 1, iy, iz + 1);
  const c011 = hash3(ix, iy + 1, iz + 1), c111 = hash3(ix + 1, iy + 1, iz + 1);
  const x00 = c000 + (c100 - c000) * ux, x10 = c010 + (c110 - c010) * ux;
  const x01 = c001 + (c101 - c001) * ux, x11 = c011 + (c111 - c011) * ux;
  const y0 = x00 + (x10 - x00) * uy, y1 = x01 + (x11 - x01) * uy;
  return y0 + (y1 - y0) * uz;
}

function fbm3(x: number, y: number, z: number, oct = 3, lac = 2.17, gain = 0.52): number {
  let a = 0.5, s = 0, n = 0;
  for (let i = 0; i < oct; i++) {
    s += a * vnoise3(x, y, z); n += a;
    x *= lac; y *= lac; z *= lac; a *= gain;
  }
  return s / Math.max(n, 1e-4);
}

/* --------------------------------------------------- geometry-region masks */

const EQ_SIN = EQUATOR_TRENCH_HALF / DS_RADIUS;      // |ny| band edge
const DISH_ANG = DISH_RADIUS / DS_RADIUS;            // rad from DS_DISH_DIR
const COR_Z = MERIDIAN_CORRIDOR_HALF / DS_RADIUS;    // |nz| corridor edge

const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _t3 = new THREE.Vector3();

const DISH_X = new THREE.Vector3();
const DISH_Y = new THREE.Vector3();
{
  const w = DS_DISH_DIR.clone();
  const t = Math.abs(w.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  DISH_X.copy(t).cross(w).normalize();
  DISH_Y.copy(w).cross(DISH_X).normalize();
}

/** metres from the nearest cut boundary (0 = on the boundary, <0 = inside a hole) */
function boundaryDistance(nx: number, ny: number, nz: number): number {
  // equatorial trench band
  const dEq = (Math.abs(ny) - EQ_SIN) * DS_RADIUS;
  // superlaser crater
  const cosA = nx * DS_DISH_DIR.x + ny * DS_DISH_DIR.y + nz * DS_DISH_DIR.z;
  const dDish = Math.acos(clamp(cosA, -1, 1)) * DS_RADIUS - DISH_RADIUS;
  // meridian corridor: rectangle in (arc-length s, world z)
  const s = Math.atan2(nx, ny) * DS_RADIUS;
  const ds = Math.max(MERIDIAN_CORRIDOR_S0 - s, 0, s - MERIDIAN_CORRIDOR_S1);
  const dz = Math.abs(nz) * DS_RADIUS - MERIDIAN_CORRIDOR_HALF;
  let dCor: number;
  if (ds > 0 && dz > 0) dCor = Math.hypot(ds, dz);
  else if (ds > 0) dCor = ds;
  else dCor = dz;
  return Math.min(dEq, dDish, dCor);
}

/**
 * Macro surface displacement in metres (+-120). Deterministic; greebles and
 * macro features sample this so everything sits on the same skin.
 * Fades to exactly 0 near every cut boundary so the fill geometry welds
 * perfectly and the trench module's `up = 0` really is the surface.
 */
export function surfaceHeight(nx: number, ny: number, nz: number): number {
  // broad continental plates
  let h = (fbm3(nx * 2.1 + 11.3, ny * 2.1 + 4.7, nz * 2.1 + 21.9, 3) - 0.5) * 128;
  // second tier of structure
  h += (fbm3(nx * 5.7 + 61.1, ny * 5.7 + 3.3, nz * 5.7 + 8.5, 2) - 0.5) * 52;
  // shallow secondary trenches carved along ridge lines
  const t = fbm3(nx * 6.9 + 130.7, ny * 6.9 + 77.1, nz * 6.9 + 41.3, 2);
  h -= smoothstep(0.72, 0.98, 1 - Math.abs(2 * t - 1)) * 62;
  // crater-like depressions
  const c = fbm3(nx * 12.3 + 5.9, ny * 12.3 + 90.2, nz * 12.3 + 31.7, 2);
  h -= smoothstep(0.60, 0.33, c) * 58;
  // fine relief
  h += (fbm3(nx * 31.0 + 3.1, ny * 31.0 + 17.7, nz * 31.0 + 55.5, 2) - 0.5) * 26;

  h = clamp(h, -120, 120);
  const d = boundaryDistance(nx, ny, nz);
  return h * smoothstep(0, 3400, d);
}

/** Structural region id 0..1 — the surface shader tints these differently. */
function regionId(nx: number, ny: number, nz: number): number {
  const v = fbm3(nx * 1.35 + 71.7, ny * 1.35 + 12.1, nz * 1.35 + 44.9, 2);
  return Math.min(5, Math.floor(v * 6.2)) / 5;
}

const _sp = new THREE.Vector3();
/** world position of the displaced surface along a unit direction */
export function surfacePoint(nx: number, ny: number, nz: number, out = _sp): THREE.Vector3 {
  const r = DS_RADIUS + surfaceHeight(nx, ny, nz);
  return out.set(nx * r, ny * r, nz * r);
}

/* ------------------------------------------------------- attribute helpers */

function tagGeo(g: THREE.BufferGeometry, emis: number, mat: number): THREE.BufferGeometry {
  const n = g.attributes.position.count;
  if (!g.attributes.aEmis) {
    const e = new Float32Array(n); e.fill(emis);
    g.setAttribute('aEmis', new THREE.BufferAttribute(e, 1));
  }
  if (!g.attributes.aMat) {
    const m = new Float32Array(n); m.fill(mat);
    g.setAttribute('aMat', new THREE.BufferAttribute(m, 1));
  }
  if (!g.attributes.uv) {
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  }
  return g;
}

/**
 * Flip an indexed geometry's winding if its triangles face inwards. Swept
 * rings and lathes are easy to author with the wrong handedness, and the
 * failure mode (a back-face-culled crater you can see the stars through) is
 * only visible from one particular angle, so just measure it.
 */
function orientOutward(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const pos = g.attributes.position.array as Float32Array;
  const idx = g.index!.array as Uint32Array | Uint16Array;
  let sum = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
    const e1x = pos[b] - pos[a], e1y = pos[b + 1] - pos[a + 1], e1z = pos[b + 2] - pos[a + 2];
    const e2x = pos[c] - pos[a], e2y = pos[c + 1] - pos[a + 1], e2z = pos[c + 2] - pos[a + 2];
    sum += (e1y * e2z - e1z * e2y) * pos[a]
         + (e1z * e2x - e1x * e2z) * pos[a + 1]
         + (e1x * e2y - e1y * e2x) * pos[a + 2];
  }
  if (sum < 0) {
    for (let i = 0; i < idx.length; i += 3) {
      const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t;
    }
    g.index!.needsUpdate = true;
    g.computeVertexNormals();
  }
  return g;
}

/** greebleKit geometries carry aEmis/aMat but not aRegion — add a flat one. */
function addRegion(g: THREE.BufferGeometry, v: number) {
  const n = g.attributes.position.count;
  const a = new Float32Array(n); a.fill(v);
  g.setAttribute('aRegion', new THREE.BufferAttribute(a, 1));
  return g;
}

/* ------------------------------------------------------------- cube sphere */

/**
 * 6 cube faces: (face centre, +u edge, +v edge) so u,v in [-1,1] spans the face.
 * Every basis is right-handed (eu x ev == the outward face normal) so that one
 * index winding gives outward-facing triangles on all six faces.
 */
const FACE_BASIS: Array<[THREE.Vector3, THREE.Vector3, THREE.Vector3]> = [
  [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 1, 0)],
  [new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0)],
  [new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0)],
  [new THREE.Vector3(0, -1, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1)],
  [new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)],
  [new THREE.Vector3(0, 0, -1), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 1, 0)],
];

/** cube point -> unit sphere, with the standard area-equalising warp */
function cubeToSphere(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
  const x2 = x * x, y2 = y * y, z2 = z * z;
  return out.set(
    x * Math.sqrt(1 - y2 * 0.5 - z2 * 0.5 + y2 * z2 / 3),
    y * Math.sqrt(1 - z2 * 0.5 - x2 * 0.5 + z2 * x2 / 3),
    z * Math.sqrt(1 - x2 * 0.5 - y2 * 0.5 + x2 * y2 / 3),
  ).normalize();
}

/**
 * Snap a direction onto the nearest cut boundary if it is within `margin`
 * metres of it, so the shell's hole edges are exact circles / lines that the
 * fill geometry can weld to without a ragged seam.
 */
function snapToBoundary(d: THREE.Vector3, margin: number): void {
  // --- equatorial band ---
  const dEq = (Math.abs(d.y) - EQ_SIN) * DS_RADIUS;
  if (Math.abs(dEq) < margin) {
    const sy = d.y >= 0 ? EQ_SIN : -EQ_SIN;
    const k = Math.sqrt(Math.max(1e-9, (1 - EQ_SIN * EQ_SIN) / Math.max(1e-9, d.x * d.x + d.z * d.z)));
    d.set(d.x * k, sy, d.z * k);
    return;
  }
  // --- dish crater rim ---
  const cosA = d.dot(DS_DISH_DIR);
  const ang = Math.acos(clamp(cosA, -1, 1));
  if (Math.abs(ang * DS_RADIUS - DISH_RADIUS) < margin) {
    // rotate along the great circle through DS_DISH_DIR so the arc is exact
    const tan = _t1.copy(d).addScaledVector(DS_DISH_DIR, -cosA);
    if (tan.lengthSq() > 1e-16) {
      tan.normalize();
      d.copy(DS_DISH_DIR).multiplyScalar(Math.cos(DISH_ANG)).addScaledVector(tan, Math.sin(DISH_ANG)).normalize();
    }
    return;
  }
  // --- meridian corridor: lateral walls, then the two end caps ---
  const s = Math.atan2(d.x, d.y) * DS_RADIUS;
  const inS = s > MERIDIAN_CORRIDOR_S0 - margin && s < MERIDIAN_CORRIDOR_S1 + margin;
  const dz = (Math.abs(d.z) - COR_Z) * DS_RADIUS;
  if (inS && Math.abs(dz) < margin) {
    const sz = d.z >= 0 ? COR_Z : -COR_Z;
    const k = Math.sqrt(Math.max(1e-9, (1 - COR_Z * COR_Z) / Math.max(1e-9, d.x * d.x + d.y * d.y)));
    d.set(d.x * k, d.y * k, sz);
    return;
  }
  if (Math.abs(d.z) < COR_Z + margin / DS_RADIUS) {
    for (const S of [MERIDIAN_CORRIDOR_S0, MERIDIAN_CORRIDOR_S1]) {
      if (Math.abs(s - S) < margin) {
        const t = S / DS_RADIUS;
        const rxy = Math.sqrt(Math.max(0, 1 - d.z * d.z));
        d.set(Math.sin(t) * rxy, Math.cos(t) * rxy, d.z);
        return;
      }
    }
  }
}

/** true if this direction is inside one of the three cut regions */
function inHole(d: THREE.Vector3): boolean {
  _t2.copy(d).multiplyScalar(DS_RADIUS);
  return inEquatorTrench(_t2) || inDishCrater(_t2) || inMeridianCorridor(_t2);
}

const SHELL_N = 160;

function buildShell(): THREE.BufferGeometry {
  const N = SHELL_N;
  const V = N + 1;
  const perFace = V * V;
  const total = perFace * 6;
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  const reg = new Float32Array(total);
  const emi = new Float32Array(total);
  const mat = new Float32Array(total);
  const dirs = new Float32Array(total * 3);   // unit directions, reused below

  // cell size in metres, used as the snap margin
  const cellM = (Math.PI * 0.5 * DS_RADIUS) / N;
  const d = new THREE.Vector3();

  for (let f = 0; f < 6; f++) {
    const [o, eu, ev] = FACE_BASIS[f];
    for (let j = 0; j <= N; j++) {
      const v = (j / N) * 2 - 1;
      for (let i = 0; i <= N; i++) {
        const u = (i / N) * 2 - 1;
        cubeToSphere(o.x + eu.x * u + ev.x * v, o.y + eu.y * u + ev.y * v, o.z + eu.z * u + ev.z * v, d);
        snapToBoundary(d, cellM * 0.75);
        const idx = f * perFace + j * V + i;
        dirs[idx * 3] = d.x; dirs[idx * 3 + 1] = d.y; dirs[idx * 3 + 2] = d.z;
        const r = DS_RADIUS + surfaceHeight(d.x, d.y, d.z);
        pos[idx * 3] = d.x * r; pos[idx * 3 + 1] = d.y * r; pos[idx * 3 + 2] = d.z * r;
        nor[idx * 3] = d.x; nor[idx * 3 + 1] = d.y; nor[idx * 3 + 2] = d.z;
        uv[idx * 2] = i / N; uv[idx * 2 + 1] = j / N;
        reg[idx] = regionId(d.x, d.y, d.z);
        emi[idx] = 0; mat[idx] = 0;
      }
    }
  }

  // ---- indices, skipping cells whose centre falls in a hole ----
  const idx: number[] = [];
  const c = new THREE.Vector3();
  for (let f = 0; f < 6; f++) {
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const a = f * perFace + j * V + i;
        const b = a + 1;
        const cIdx = a + V;
        const dIdx = cIdx + 1;
        c.set(
          dirs[a * 3] + dirs[b * 3] + dirs[cIdx * 3] + dirs[dIdx * 3],
          dirs[a * 3 + 1] + dirs[b * 3 + 1] + dirs[cIdx * 3 + 1] + dirs[dIdx * 3 + 1],
          dirs[a * 3 + 2] + dirs[b * 3 + 2] + dirs[cIdx * 3 + 2] + dirs[dIdx * 3 + 2],
        ).normalize();
        if (inHole(c)) continue;
        idx.push(a, cIdx, b, b, cIdx, dIdx);
      }
    }
  }

  // Force every triangle to wind outwards. The six cube bases do not all have
  // the same handedness, and getting this wrong leaves a hemisphere inside-out
  // — invisible from outside, but you see straight through the trench hole to
  // the far wall. Checking each triangle against its own radius cannot be wrong.
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3, b = idx[i + 1] * 3, cI = idx[i + 2] * 3;
    const e1x = pos[b] - pos[a], e1y = pos[b + 1] - pos[a + 1], e1z = pos[b + 2] - pos[a + 2];
    const e2x = pos[cI] - pos[a], e2y = pos[cI + 1] - pos[a + 1], e2z = pos[cI + 2] - pos[a + 2];
    const nx2 = e1y * e2z - e1z * e2y;
    const ny2 = e1z * e2x - e1x * e2z;
    const nz2 = e1x * e2y - e1y * e2x;
    if (nx2 * pos[a] + ny2 * pos[a + 1] + nz2 * pos[a + 2] < 0) {
      const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t;
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('aRegion', new THREE.BufferAttribute(reg, 1));
  g.setAttribute('aEmis', new THREE.BufferAttribute(emi, 1));
  g.setAttribute('aMat', new THREE.BufferAttribute(mat, 1));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
  g.computeVertexNormals();

  // The six faces have their own copies of the shared edge vertices, so the
  // recomputed normals disagree there and a hard crease runs down every cube
  // seam. Average them back together (only ~4k vertices, so this is cheap).
  {
    const nAttr = g.attributes.normal.array as Float32Array;
    const buckets = new Map<string, number[]>();
    for (let f = 0; f < 6; f++) {
      for (let j = 0; j <= N; j++) {
        for (let i = 0; i <= N; i++) {
          if (i !== 0 && i !== N && j !== 0 && j !== N) continue;
          const k = f * perFace + j * V + i;
          const key = `${Math.round(pos[k * 3] * 0.05)},${Math.round(pos[k * 3 + 1] * 0.05)},${Math.round(pos[k * 3 + 2] * 0.05)}`;
          const arr = buckets.get(key);
          if (arr) arr.push(k); else buckets.set(key, [k]);
        }
      }
    }
    for (const arr of buckets.values()) {
      if (arr.length < 2) continue;
      let ax = 0, ay = 0, az = 0;
      for (const k of arr) { ax += nAttr[k * 3]; ay += nAttr[k * 3 + 1]; az += nAttr[k * 3 + 2]; }
      const l = Math.hypot(ax, ay, az) || 1;
      ax /= l; ay /= l; az /= l;
      for (const k of arr) { nAttr[k * 3] = ax; nAttr[k * 3 + 1] = ay; nAttr[k * 3 + 2] = az; }
    }
  }

  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), DS_RADIUS + 1200);
  return g;
}

/* ==========================================================================
   EQUATORIAL TRENCH
   A swept ring filling |y| < EQUATOR_TRENCH_HALF: two 700 m walls, a stepped
   floor, and instanced ribs / gantries / strip lights crossing the channel.
   ========================================================================== */

/** cross-section: [latitude as a fraction of EQ_SIN, radial offset in metres, emissive, matId] */
const EQ_PROFILE: Array<[number, number, number, number]> = [
  [1.020, -4, 0, 0],     // tucked just under the shell edge — welds the seam
  [1.000, 0, 0, 0],
  [0.975, 34, 0, 0],     // raised lip
  [0.955, 30, 0, 0],
  [0.950, -70, 0, 1],    // first shoulder
  [0.930, -96, 0, 1],
  [0.926, -132, 1, 3],   // upper light strip
  [0.918, -150, 0, 1],
  [0.905, -430, 0, 1],   // main wall
  [0.898, -470, 1, 3],   // lower light strip
  [0.893, -520, 0, 1],
  [0.880, -690, 0, 0],   // wall foot
  [0.840, -706, 0, 0],   // floor bench
  [0.700, -712, 0, 0],
  [0.300, -742, 0, 0],   // shallow central channel
  [0.000, -756, 0, 0],
];

function buildEquatorTrench(rng: RNG): { geo: THREE.BufferGeometry; ribs: THREE.BufferGeometry } {
  const SEG = 768;
  // full profile: north side (descending) then mirrored south side
  const prof: Array<[number, number, number, number]> = [];
  for (let i = 0; i < EQ_PROFILE.length; i++) prof.push(EQ_PROFILE[i]);
  for (let i = EQ_PROFILE.length - 2; i >= 0; i--) {
    const p = EQ_PROFILE[i];
    prof.push([-p[0], p[1], p[2], p[3]]);
  }
  const P = prof.length;
  const vCount = (SEG + 1) * P;
  const pos = new Float32Array(vCount * 3);
  const uv = new Float32Array(vCount * 2);
  const emi = new Float32Array(vCount);
  const mat = new Float32Array(vCount);
  const reg = new Float32Array(vCount);

  for (let s = 0; s <= SEG; s++) {
    const a = (s / SEG) * Math.PI * 2;
    const cx = Math.cos(a), cz = Math.sin(a);
    // slow longitudinal variation so the channel is not a perfect extrusion
    const wob = (vnoise3(cx * 3.1 + 5.0, 0, cz * 3.1 + 5.0) - 0.5);
    for (let p = 0; p < P; p++) {
      const [latF, ro, em, mt] = prof[p];
      const ny = latF * EQ_SIN;
      const k = Math.sqrt(Math.max(0, 1 - ny * ny));
      let r = DS_RADIUS + ro;
      if (Math.abs(latF) < 0.99) r += wob * 46 * (1 - Math.abs(latF));
      const idx = s * P + p;
      pos[idx * 3] = cx * k * r;
      pos[idx * 3 + 1] = ny * r;
      pos[idx * 3 + 2] = cz * k * r;
      uv[idx * 2] = (s / SEG) * 260;
      uv[idx * 2 + 1] = p / (P - 1);
      emi[idx] = em;
      mat[idx] = mt;
      reg[idx] = 0.35;
    }
  }
  const idx: number[] = [];
  for (let s = 0; s < SEG; s++) {
    for (let p = 0; p < P - 1; p++) {
      const a = s * P + p, b = a + P;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('aEmis', new THREE.BufferAttribute(emi, 1));
  geo.setAttribute('aMat', new THREE.BufferAttribute(mat, 1));
  geo.setAttribute('aRegion', new THREE.BufferAttribute(reg, 1));
  geo.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
  geo.computeVertexNormals();
  orientOutward(geo);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), DS_RADIUS + 200);

  // ---- one rib/gantry prototype, instanced around the ring ----
  const W = EQ_SIN * 1.78 * DS_RADIUS;    // channel width in metres (~1690)
  const parts: THREE.BufferGeometry[] = [];
  // cross-member spanning the channel just below the rim
  parts.push(box(160, 80, W, 0, 1).translate(0, -170, 0));
  parts.push(box(220, 46, W * 0.30, 0, 0).translate(0, -100, 0));
  parts.push(box(100, 14, W, 1, 3).translate(0, -186, 0));   // lit underside
  // a second, deeper span
  parts.push(box(110, 60, W * 0.94, 0, 1).translate(0, -470, 0));
  // buttress legs braced against both walls
  for (const sgn of [-1, 1]) {
    parts.push(box(130, 430, 130, 0, 1).translate(0, -690, sgn * W * 0.455));
    parts.push(taperedCyl(46, 22, 470, 7, 0, 2).translate(0, -260, sgn * W * 0.40));
    parts.push(box(250, 60, 210, 0, 0).translate(0, -756, sgn * W * 0.40));
    // gantry mast rising above the rim — breaks the silhouette from far out
    parts.push(taperedCyl(58, 26, 330, 7, 0, 2).translate(0, 0, sgn * W * 0.49));
    parts.push(box(70, 26, 90, 1, 3).translate(0, 330, sgn * W * 0.49));
  }
  // machinery block on the floor
  parts.push(slab(320, 140, 430, 24, 0, 0).translate(0, -756, rng.range(-0.2, 0.2) * W));
  parts.push(box(130, 34, 210, 1, 3).translate(0, -616, 0));
  const ribs = mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)), false)!;
  ribs.computeVertexNormals();
  addRegion(ribs, 0.35);
  return { geo, ribs };
}

/* ==========================================================================
   SUPERLASER CRATER
   Stepped rim terraces -> parabolic dish floor -> 8 tributary emitters ->
   central focusing lens with a dim green core, plus radial support spars.
   ========================================================================== */

/** unit direction at (arc-length from the dish axis, angle around it) */
function dishDir(arc: number, phi: number, out = new THREE.Vector3()): THREE.Vector3 {
  const a = arc / DS_RADIUS;
  const ca = Math.cos(a), sa = Math.sin(a);
  const cx = Math.cos(phi) * sa, cy = Math.sin(phi) * sa;
  return out.set(
    DS_DISH_DIR.x * ca + DISH_X.x * cx + DISH_Y.x * cy,
    DS_DISH_DIR.y * ca + DISH_X.y * cx + DISH_Y.y * cy,
    DS_DISH_DIR.z * ca + DISH_X.z * cx + DISH_Y.z * cy,
  ).normalize();
}

/** [arc from centre (m), radial offset (m), emissive, matId] — outer to inner */
const DISH_PROFILE: Array<[number, number, number, number]> = [
  [DISH_RADIUS + 26, -4, 0, 0],   // tucked under the shell edge
  [DISH_RADIUS, 0, 0, 0],
  [DISH_RADIUS - 120, 86, 0, 0],  // proud rim lip — reads on the silhouette
  [DISH_RADIUS - 300, 74, 0, 0],
  [DISH_RADIUS - 330, -180, 0, 1],
  [DISH_RADIUS - 900, -210, 0, 1],   // terrace 1
  [DISH_RADIUS - 940, -560, 1, 3],
  [DISH_RADIUS - 1560, -600, 0, 1],  // terrace 2
  [DISH_RADIUS - 1600, -980, 0, 1],
  [DISH_RADIUS - 2260, -1030, 0, 1], // terrace 3
  [DISH_RADIUS - 2300, -1420, 1, 3],
  [DISH_RADIUS - 2900, -1470, 0, 1], // terrace 4
  [DISH_RADIUS - 2960, -1760, 0, 2],
];

function buildDishShell(): THREE.BufferGeometry {
  const SEG = 192;
  const prof: Array<[number, number, number, number]> = DISH_PROFILE.slice();
  // parabolic floor from the last terrace down to the centre
  const a0 = prof[prof.length - 1][0], r0 = prof[prof.length - 1][1];
  const rDeep = -2980;
  const RINGS = 22;
  for (let i = 1; i <= RINGS; i++) {
    const t = 1 - i / RINGS;              // 1 -> 0
    const arc = a0 * t;
    const ro = rDeep + (r0 - rDeep) * t * t;
    prof.push([arc, ro, 0, i > RINGS - 3 ? 2 : 1]);
  }
  const P = prof.length;
  const vCount = (SEG + 1) * P;
  const pos = new Float32Array(vCount * 3);
  const uv = new Float32Array(vCount * 2);
  const emi = new Float32Array(vCount);
  const mat = new Float32Array(vCount);
  const reg = new Float32Array(vCount);
  const d = new THREE.Vector3();
  for (let s = 0; s <= SEG; s++) {
    const phi = (s / SEG) * Math.PI * 2;
    for (let p = 0; p < P; p++) {
      const [arc, ro, em, mt] = prof[p];
      dishDir(arc, phi, d);
      // scallop the terraces so the rim is not a perfect circle
      let r = DS_RADIUS + ro;
      if (arc < DISH_RADIUS - 100 && arc > 200) {
        r += Math.sin(phi * 8.0 + arc * 0.0011) * 26 + Math.sin(phi * 3.0) * 34;
      }
      const idx = s * P + p;
      pos[idx * 3] = d.x * r; pos[idx * 3 + 1] = d.y * r; pos[idx * 3 + 2] = d.z * r;
      uv[idx * 2] = (s / SEG) * 60; uv[idx * 2 + 1] = arc / DISH_RADIUS;
      emi[idx] = em; mat[idx] = mt; reg[idx] = 0.8;
    }
  }
  const idx: number[] = [];
  for (let s = 0; s < SEG; s++) {
    for (let p = 0; p < P - 1; p++) {
      const a = s * P + p, b = a + P;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('aEmis', new THREE.BufferAttribute(emi, 1));
  g.setAttribute('aMat', new THREE.BufferAttribute(mat, 1));
  g.setAttribute('aRegion', new THREE.BufferAttribute(reg, 1));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
  g.computeVertexNormals();
  orientOutward(g);
  return g;
}

/** orientation with local +Y along `d` (radial up), +X along an arbitrary tangent */
function quatForDir(d: THREE.Vector3, roll = 0, out = new THREE.Quaternion()): THREE.Quaternion {
  const up = _t1.copy(d).normalize();
  const ref = Math.abs(up.y) > 0.95 ? _t2.set(1, 0, 0) : _t2.set(0, 1, 0);
  const xa = _t3.copy(ref).cross(up).normalize();
  const za = new THREE.Vector3().copy(xa).cross(up).normalize();
  const m = new THREE.Matrix4().makeBasis(xa, up, za);
  out.setFromRotationMatrix(m);
  if (roll) out.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), roll));
  return out;
}

function buildDishFurniture(rng: RNG): { main: THREE.BufferGeometry; core: THREE.BufferGeometry } {
  const parts: THREE.BufferGeometry[] = [];
  const q = new THREE.Quaternion();
  const d = new THREE.Vector3();
  const m4 = new THREE.Matrix4();

  const put = (g: THREE.BufferGeometry, arc: number, phi: number, radialOffset: number, roll = 0) => {
    dishDir(arc, phi, d);
    quatForDir(d, roll, q);
    const r = DS_RADIUS + radialOffset;
    m4.compose(new THREE.Vector3(d.x * r, d.y * r, d.z * r), q, new THREE.Vector3(1, 1, 1));
    g.applyMatrix4(m4);
    parts.push(g);
  };

  // --- 8 tributary beam emitters on the second terrace ---
  for (let i = 0; i < 8; i++) {
    const phi = (i / 8) * Math.PI * 2 + 0.19;
    const arc = DISH_RADIUS - 1900;
    const sub: THREE.BufferGeometry[] = [];
    sub.push(taperedCyl(300, 190, 900, 12, 0, 0));
    sub.push(cyl(210, 260, 12, 0, 1).translate(0, 900, 0));
    sub.push(taperedCyl(160, 90, 620, 10, 0, 2).translate(0, 1160, 0));
    sub.push(cyl(120, 90, 12, 0.5, 3).translate(0, 1780, 0));
    sub.push(box(150, 70, 480, 0, 1).translate(0, 300, 0));
    sub.push(box(700, 90, 700, 0, 0).translate(0, -60, 0));
    for (let k = 0; k < 3; k++) {
      sub.push(box(90, 140, 90, 0, 1).translate(rng.range(-260, 260), 900, rng.range(-260, 260)));
    }
    const g = mergeGeometries(sub.map((p) => (p.index ? p.toNonIndexed() : p)), false)!;
    g.computeVertexNormals();
    put(g, arc, phi, -1030);
  }

  // --- radial support spars spanning rim -> hub ---
  for (let i = 0; i < 12; i++) {
    const phi = (i / 12) * Math.PI * 2;
    const steps = 10;
    const sp: THREE.BufferGeometry[] = [];
    for (let k = 0; k < steps; k++) {
      const t0 = k / steps, t1 = (k + 1) / steps;
      const arcA = DISH_RADIUS * (1 - t0) * 0.96 + 40;
      const arcB = DISH_RADIUS * (1 - t1) * 0.96 + 40;
      const roA = -2980 + 2980 * (arcA / DISH_RADIUS) * (arcA / DISH_RADIUS) + 190;
      const roB = -2980 + 2980 * (arcB / DISH_RADIUS) * (arcB / DISH_RADIUS) + 190;
      const pa = dishDir(arcA, phi, new THREE.Vector3()).multiplyScalar(DS_RADIUS + roA);
      const pb = dishDir(arcB, phi, new THREE.Vector3()).multiplyScalar(DS_RADIUS + roB);
      const len = pa.distanceTo(pb);
      const seg = box(150, len, 150, k % 3 === 0 ? 0.28 : 0, k % 3 === 0 ? 3 : 2);
      const mid = pa.clone().add(pb).multiplyScalar(0.5);
      const dir = pb.clone().sub(pa).normalize();
      const qq = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      seg.applyMatrix4(new THREE.Matrix4().compose(pa, qq, new THREE.Vector3(1, 1, 1)));
      void mid;
      sp.push(seg);
    }
    const g = mergeGeometries(sp.map((p) => (p.index ? p.toNonIndexed() : p)), false)!;
    g.computeVertexNormals();
    parts.push(g);
  }

  // --- central focusing lens assembly (its own geometry: green core tint) ---
  const coreParts: THREE.BufferGeometry[] = [];
  {
    const sub = coreParts;
    sub.push(cyl(1200, 260, 24, 0, 0));
    sub.push(taperedCyl(1050, 700, 420, 24, 0, 1).translate(0, 260, 0));
    sub.push(cyl(760, 180, 20, 0, 2).translate(0, 680, 0));
    // the emitter eye
    const eye = new THREE.SphereGeometry(520, 24, 16);
    eye.translate(0, 700, 0);
    sub.push(tagGeo(eye, 1, 3));
    // collar of 8 small focusing barrels around the eye
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const b = taperedCyl(120, 70, 700, 8, 0, 2);
      b.rotateX(0.42);
      b.rotateY(a);
      b.translate(Math.cos(a) * 900, 300, Math.sin(a) * 900);
      sub.push(b);
      const t = cyl(84, 60, 8, 0.6, 3);
      t.translate(Math.cos(a) * 900 * 0.72, 900, Math.sin(a) * 900 * 0.72);
      sub.push(t);
    }
  }
  const core = mergeGeometries(coreParts.map((p) => (p.index ? p.toNonIndexed() : p)), false)!;
  core.computeVertexNormals();
  {
    dishDir(0, 0, d);
    quatForDir(d, 0, q);
    const r = DS_RADIUS - 2980;
    core.applyMatrix4(m4.compose(new THREE.Vector3(d.x * r, d.y * r, d.z * r), q, new THREE.Vector3(1, 1, 1)));
  }
  addRegion(core, 0.8);

  const all = mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)), false)!;
  all.computeVertexNormals();
  addRegion(all, 0.8);
  return { main: all, core };
}

/* ==========================================================================
   SECONDARY MACRO FEATURES
   Six large one-off structures, each built in a local frame (+Y = radial up,
   origin on the displaced surface) and placed with a quaternion.
   ========================================================================== */

function mergeAll(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)), false)!;
  g.computeVertexNormals();
  return g;
}

/** Huge docking bay complex: raised apron, sunken lit bay, cranes and towers. */
function featDockingBay(rng: RNG): THREE.BufferGeometry {
  const p: THREE.BufferGeometry[] = [];
  const W = 4200, D = 2800;
  p.push(slab(W, 300, D, 90, 0, 0).translate(0, -260, 0));            // apron, buried skirt
  p.push(slab(W * 0.82, 90, D * 0.82, 70, 0, 1).translate(0, 40, 0));
  // the bay itself: four walls + a bright floor, standing proud so nothing z-fights
  const bw = 2000, bd = 1100, bh = 420;
  for (const sx of [-1, 1]) p.push(box(140, bh, bd + 280, 0, 1).translate(sx * (bw / 2 + 70), 40, 0));
  for (const sz of [-1, 1]) p.push(box(bw + 280, bh, 140, 0, 1).translate(0, 40, sz * (bd / 2 + 70)));
  p.push(box(bw, 40, bd, 1, 3).translate(0, 40, 0));                   // lit deck
  for (let i = 0; i < 7; i++) {
    p.push(box(70, 30, bd, 1, 3).translate((i / 6 - 0.5) * bw * 0.9, 400, 0));  // ceiling strips
  }
  // gantry cranes over the bay
  for (let i = 0; i < 4; i++) {
    const x = (i / 3 - 0.5) * bw * 0.8;
    p.push(box(80, 520, 90, 0, 2).translate(x, 40, -bd / 2 - 60));
    p.push(box(80, 520, 90, 0, 2).translate(x, 40, bd / 2 + 60));
    p.push(box(110, 70, bd + 200, 0, 1).translate(x, 560, 0));
  }
  // control towers + machinery clusters around the rim
  for (let i = 0; i < 9; i++) {
    const a = rng.range(0, Math.PI * 2), rr = rng.range(1500, 2050);
    const g = rng.bool(0.45) ? tower(rng, 16) : machinery(rng, 14);
    p.push(g.translate(Math.cos(a) * rr, 40, Math.sin(a) * rr * 0.66));
  }
  return mergeAll(p);
}

/** Sensor array field: one big steerable dish plus a forest of antennae. */
function featSensorArray(rng: RNG): THREE.BufferGeometry {
  const p: THREE.BufferGeometry[] = [];
  p.push(slab(3400, 260, 3400, 120, 0, 0).translate(0, -230, 0));
  // main dish on a yoke
  p.push(cyl(420, 240, 16, 0, 0).translate(0, 30, 0));
  for (const sx of [-1, 1]) p.push(box(140, 620, 220, 0, 1).translate(sx * 320, 270, 0));
  const dish = new THREE.SphereGeometry(900, 28, 14, 0, Math.PI * 2, 0, Math.PI * 0.36);
  dish.rotateX(Math.PI * 1.18);
  dish.translate(0, 900, 0);
  p.push(tagGeo(dish, 0, 1));
  p.push(taperedCyl(70, 30, 620, 8, 0, 2).translate(0, 620, 0));
  p.push(cyl(60, 60, 8, 1, 3).translate(0, 1240, 0));
  // antenna forest
  for (let i = 0; i < 22; i++) {
    const a = rng.range(0, Math.PI * 2), rr = rng.range(700, 1650);
    p.push(antenna(rng, rng.range(7, 15)).translate(Math.cos(a) * rr, 20, Math.sin(a) * rr));
  }
  for (let i = 0; i < 8; i++) {
    const a = rng.range(0, Math.PI * 2), rr = rng.range(900, 1700);
    p.push(vent(rng, 16).translate(Math.cos(a) * rr, 20, Math.sin(a) * rr));
  }
  return mergeAll(p);
}

/** A second, smaller superlaser-style dish sunk into a raised ring. */
function featSecondDish(rng: RNG): THREE.BufferGeometry {
  const p: THREE.BufferGeometry[] = [];
  const SEG = 72;
  // lathe profile: [radius, y]
  const prof: Array<[number, number]> = [
    [2600, -380], [2440, 150], [2280, 130], [2260, -120],
    [1900, -150], [1880, -420], [1500, -450], [1480, -700],
  ];
  for (let i = 12; i >= 0; i--) {
    const t = i / 12;
    prof.push([1480 * t, -700 - 620 * (1 - t * t)]);
  }
  const P = prof.length;
  const pos = new Float32Array((SEG + 1) * P * 3);
  const idx: number[] = [];
  for (let s = 0; s <= SEG; s++) {
    const a = (s / SEG) * Math.PI * 2;
    for (let k = 0; k < P; k++) {
      const [rr, y] = prof[k];
      const i3 = (s * P + k) * 3;
      pos[i3] = Math.cos(a) * rr; pos[i3 + 1] = y; pos[i3 + 2] = Math.sin(a) * rr;
    }
  }
  for (let s = 0; s < SEG; s++) {
    for (let k = 0; k < P - 1; k++) {
      const a = s * P + k, b = a + P;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const lathe = new THREE.BufferGeometry();
  lathe.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  lathe.setIndex(idx);
  lathe.computeVertexNormals();
  {
    // the lathe lives in a local +Y-up frame, so "outward" here is +Y
    const lp = lathe.attributes.position.array as Float32Array;
    const li = lathe.index!.array as Uint32Array;
    let sum = 0;
    for (let i = 0; i < li.length; i += 3) {
      const a = li[i] * 3, b = li[i + 1] * 3, c = li[i + 2] * 3;
      const e1x = lp[b] - lp[a], e1y = lp[b + 1] - lp[a + 1], e1z = lp[b + 2] - lp[a + 2];
      const e2x = lp[c] - lp[a], e2y = lp[c + 1] - lp[a + 1], e2z = lp[c + 2] - lp[a + 2];
      sum += e1z * e2x - e1x * e2z;
    }
    if (sum < 0) {
      for (let i = 0; i < li.length; i += 3) { const t = li[i + 1]; li[i + 1] = li[i + 2]; li[i + 2] = t; }
      lathe.computeVertexNormals();
    }
  }
  p.push(tagGeo(lathe.toNonIndexed(), 0, 1));
  // emitter cluster in the middle
  p.push(cyl(340, 220, 16, 0, 0).translate(0, -1320, 0));
  p.push(taperedCyl(260, 150, 420, 12, 0, 2).translate(0, -1100, 0));
  p.push(cyl(150, 120, 12, 1, 3).translate(0, -680, 0));
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    p.push(tower(rng, 12).translate(Math.cos(a) * 2300, 60, Math.sin(a) * 2300));
    p.push(box(90, 40, 700, 1, 3).translate(Math.cos(a) * 2050, 130, Math.sin(a) * 2050));
  }
  return mergeAll(p);
}

/** Polar array: a big ring truss on legs with a mast cluster inside. */
function featPolarArray(rng: RNG): THREE.BufferGeometry {
  const p: THREE.BufferGeometry[] = [];
  p.push(slab(3000, 240, 3000, 140, 0, 0).translate(0, -210, 0));
  const RR = 1450;
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * Math.PI * 2, a2 = ((i + 1) / 40) * Math.PI * 2;
    const x0 = Math.cos(a) * RR, z0 = Math.sin(a) * RR;
    const x1 = Math.cos(a2) * RR, z1 = Math.sin(a2) * RR;
    const len = Math.hypot(x1 - x0, z1 - z0);
    const seg = box(len * 1.05, 110, 200, i % 4 === 0 ? 1 : 0, i % 4 === 0 ? 3 : 1);
    seg.rotateY(-Math.atan2(z1 - z0, x1 - x0));
    seg.translate((x0 + x1) / 2, 760, (z0 + z1) / 2);
    p.push(seg);
    if (i % 5 === 0) p.push(box(150, 800, 150, 0, 2).translate(x0, 20, z0));
  }
  for (let i = 0; i < 14; i++) {
    const a = rng.range(0, Math.PI * 2), rr = rng.range(120, 1150);
    p.push(tower(rng, rng.range(10, 20)).translate(Math.cos(a) * rr, 20, Math.sin(a) * rr));
  }
  p.push(taperedCyl(180, 60, 1900, 10, 0, 2).translate(0, 20, 0));
  p.push(cyl(120, 110, 10, 1, 3).translate(0, 1920, 0));
  return mergeAll(p);
}

/** Reactor exhaust field: five deep vent throats with glowing cores. */
function featReactorVents(rng: RNG): THREE.BufferGeometry {
  const p: THREE.BufferGeometry[] = [];
  p.push(slab(3800, 280, 2600, 130, 0, 0).translate(0, -250, 0));
  const spots: Array<[number, number, number]> = [
    [0, 0, 520], [-1200, -700, 380], [1200, -700, 380], [-1200, 700, 380], [1200, 700, 380],
  ];
  for (const [x, z, r] of spots) {
    p.push(cyl(r * 1.42, 130, 20, 0, 0).translate(x, 30, z));
    p.push(cyl(r * 1.18, 220, 20, 0, 1).translate(x, 120, z));
    p.push(cyl(r * 0.9, 40, 20, 1, 3).translate(x, 200, z));           // glowing throat
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      p.push(box(90, 300, 90, 0, 2).translate(x + Math.cos(a) * r * 1.3, 130, z + Math.sin(a) * r * 1.3));
    }
  }
  for (let i = 0; i < 10; i++) {
    p.push(machinery(rng, rng.range(10, 18)).translate(rng.range(-1750, 1750), 20, rng.range(-1150, 1150)));
  }
  return mergeAll(p);
}

/** Dense hangar / habitation block — a city of machinery. */
function featHangarCity(rng: RNG): THREE.BufferGeometry {
  const p: THREE.BufferGeometry[] = [];
  p.push(slab(4600, 320, 3200, 150, 0, 0).translate(0, -290, 0));
  for (let i = 0; i < 46; i++) {
    const x = rng.range(-2100, 2100), z = rng.range(-1400, 1400);
    const k = rng.next();
    if (k < 0.45) p.push(machinery(rng, rng.range(8, 20)).translate(x, 20, z));
    else if (k < 0.72) p.push(tower(rng, rng.range(8, 22)).translate(x, 20, z));
    else if (k < 0.88) p.push(vent(rng, rng.range(10, 20)).translate(x, 20, z));
    else p.push(antenna(rng, rng.range(8, 16)).translate(x, 20, z));
  }
  // elevated transit spines with lit rails
  for (let i = 0; i < 3; i++) {
    const z = (i - 1) * 1000;
    p.push(box(4200, 90, 160, 0, 1).translate(0, 460, z));
    p.push(box(4200, 24, 40, 1, 3).translate(0, 556, z));
    for (let k = 0; k < 9; k++) p.push(box(130, 480, 130, 0, 2).translate((k / 8 - 0.5) * 4000, 20, z));
  }
  return mergeAll(p);
}

const FEATURE_DIRS: Array<[number, number, number]> = [
  [0.75, 0.35, 0.56],
  [-0.62, 0.28, 0.73],
  [-0.45, -0.55, -0.70],
  [0.05, -0.99, 0.10],
  [0.30, 0.80, 0.52],
  [-0.88, -0.30, 0.36],
];

/**
 * Six macro features, each returned as a local-space geometry plus the world
 * transform that seats it on the displaced surface. Keeping them local (rather
 * than baking world coordinates) keeps the shader's triplanar plating precise
 * at 50 km from the origin.
 */
function buildFeatures(rng: RNG): Array<{ geo: THREE.BufferGeometry; pos: THREE.Vector3; quat: THREE.Quaternion }> {
  const builders = [featDockingBay, featSensorArray, featSecondDish, featPolarArray, featHangarCity, featReactorVents];
  const out: Array<{ geo: THREE.BufferGeometry; pos: THREE.Vector3; quat: THREE.Quaternion }> = [];
  const d = new THREE.Vector3();
  for (let i = 0; i < builders.length; i++) {
    const geo = builders[i](rng.fork(i + 3));
    addRegion(geo, 0.15 + 0.14 * i);
    const [x, y, z] = FEATURE_DIRS[i];
    d.set(x, y, z).normalize();
    const quat = quatForDir(d, rng.range(0, Math.PI * 2), new THREE.Quaternion());
    const r = DS_RADIUS + surfaceHeight(d.x, d.y, d.z);
    out.push({ geo, pos: new THREE.Vector3(d.x * r, d.y * r, d.z * r), quat });
  }
  return out;
}

/** Move a geometry's centroid to the origin and return where it used to be. */
function recenter(g: THREE.BufferGeometry): THREE.Vector3 {
  g.computeBoundingSphere();
  const c = g.boundingSphere!.center.clone();
  g.translate(-c.x, -c.y, -c.z);
  g.computeBoundingSphere();
  return c;
}

/* ==========================================================================
   GREEBLE STREAMING
   A fixed cube-face lattice covers the whole sphere. Every rebuild we walk
   the lattice once, keep the cells inside the LOD rings, and refill the
   InstancedMesh matrices. Rebuilds only happen when the camera crosses into
   a new ground cell, so this costs nothing on a typical frame.
   ========================================================================== */

const GN = 96;                                   // cells per cube-face side
const CELL_COUNT = 6 * GN * GN;
const CELL_M = (Math.PI * 0.5 * DS_RADIUS) / GN; // ~818 m

const RING_BIG = 30000, FADE_BIG: [number, number] = [25000, 30000];
const RING_MED = 8000, FADE_MED: [number, number] = [6600, 8000];
const RING_SMALL = 2000, FADE_SMALL: [number, number] = [1650, 2000];
const STREAM_ALT = 42000;                        // stop streaming above this altitude

let CELL_DIRS: Float32Array | null = null;
function cellDirs(): Float32Array {
  if (CELL_DIRS) return CELL_DIRS;
  const a = new Float32Array(CELL_COUNT * 3);
  const d = new THREE.Vector3();
  let k = 0;
  for (let f = 0; f < 6; f++) {
    const [o, eu, ev] = FACE_BASIS[f];
    for (let j = 0; j < GN; j++) {
      const v = ((j + 0.5) / GN) * 2 - 1;
      for (let i = 0; i < GN; i++) {
        const u = ((i + 0.5) / GN) * 2 - 1;
        cubeToSphere(o.x + eu.x * u + ev.x * v, o.y + eu.y * u + ev.y * v, o.z + eu.z * u + ev.z * v, d);
        a[k++] = d.x; a[k++] = d.y; a[k++] = d.z;
      }
    }
  }
  CELL_DIRS = a;
  return a;
}

/** direction -> lattice cell index (matches FACE_BASIS) */
function dirToCell(d: THREE.Vector3): number {
  const ax = Math.abs(d.x), ay = Math.abs(d.y), az = Math.abs(d.z);
  let f = 0, u = 0, v = 0;
  if (ax >= ay && ax >= az) {
    if (d.x > 0) { f = 0; u = -d.z / ax; v = d.y / ax; }
    else { f = 1; u = d.z / ax; v = d.y / ax; }
  } else if (ay >= az) {
    if (d.y > 0) { f = 2; u = d.z / ay; v = d.x / ay; }
    else { f = 3; u = d.x / ay; v = d.z / ay; }
  } else {
    if (d.z > 0) { f = 4; u = d.x / az; v = d.y / az; }
    else { f = 5; u = -d.x / az; v = d.y / az; }
  }
  const i = Math.min(GN - 1, Math.max(0, Math.floor(((u + 1) * 0.5) * GN)));
  const j = Math.min(GN - 1, Math.max(0, Math.floor(((v + 1) * 0.5) * GN)));
  return (f * GN + j) * GN + i;
}

interface GreebleRing {
  meshes: THREE.InstancedMesh[];
  counts: number[];
  cap: number;
  radius: number;
}

function makeRing(geos: THREE.BufferGeometry[], mat: THREE.Material, cap: number, radius: number): GreebleRing {
  const meshes = geos.map((g) => {
    // lift anything that hangs below its base so nothing sinks into the hull
    g.computeBoundingBox();
    const minY = g.boundingBox!.min.y;
    if (minY < -1) g.translate(0, -minY, 0);
    addRegion(g, 0.5);
    const m = new THREE.InstancedMesh(g, mat, cap);
    m.frustumCulled = false;
    m.count = 0;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    return m;
  });
  return { meshes, counts: geos.map(() => 0), cap, radius };
}

/* ------------------------------------------------------------------ factory */

export function createDeathStar(opts: { seed?: number } = {}): DeathStar {
  const seed = opts.seed ?? 20250908;
  const rng = new RNG(seed);
  const group = new THREE.Group();
  group.name = 'deathstar';
  const materials: THREE.Material[] = [];
  const disposables: Array<{ dispose(): void }> = [];

  /* ---- materials ---- */
  const shellMat = createSurfaceMaterial({ seed: seed % 977, radius: DS_RADIUS, projection: 'cube', detailScale: 1 });
  const ringMat = createSurfaceMaterial({ seed: (seed + 31) % 977, radius: DS_RADIUS, projection: 'uv', detailScale: 1, color: 0x969ca3, windowStrength: 1.35, emissiveStrength: 1.7 });
  const dishMat = createSurfaceMaterial({ seed: (seed + 57) % 977, radius: DS_RADIUS, projection: 'cube', detailScale: 7, color: 0xa2a8ad, windowStrength: 0.30 });
  const structMat = createSurfaceMaterial({ seed: (seed + 91) % 977, radius: DS_RADIUS, projection: 'local', detailScale: 0.34, color: 0x8f959c, windowStrength: 0.8, emissiveStrength: 0.75 });
  const gBigMat = createSurfaceMaterial({ seed: (seed + 13) % 977, radius: DS_RADIUS, projection: 'local', detailScale: 1.0, color: 0x8f959c, windowStrength: 0.55, emissiveStrength: 0.5, instanceFade: FADE_BIG });
  const gMedMat = createSurfaceMaterial({ seed: (seed + 17) % 977, radius: DS_RADIUS, projection: 'local', detailScale: 1.6, color: 0x8f959c, windowStrength: 0.55, emissiveStrength: 0.5, instanceFade: FADE_MED });
  const gSmlMat = createSurfaceMaterial({ seed: (seed + 19) % 977, radius: DS_RADIUS, projection: 'local', detailScale: 2.6, color: 0x949aa1, windowStrength: 0.55, emissiveStrength: 0.5, instanceFade: FADE_SMALL });
  const coreMat = createSurfaceMaterial({ seed: (seed + 77) % 977, radius: DS_RADIUS, projection: 'local', detailScale: 0.9, color: 0x7e858c, emissiveTint: 0x2fff86, emissiveStrength: 2.0, windowStrength: 0.2 });
  materials.push(shellMat, ringMat, dishMat, structMat, gBigMat, gMedMat, gSmlMat, coreMat);

  /* ---- macro shell ---- */
  const shellGeo = buildShell();
  disposables.push(shellGeo);
  const shell = new THREE.Mesh(shellGeo, shellMat);
  shell.name = 'ds-shell';
  shell.frustumCulled = false;
  group.add(shell);

  /* ---- equatorial trench ---- */
  const eq = buildEquatorTrench(rng.fork(11));
  disposables.push(eq.geo, eq.ribs);
  const eqMesh = new THREE.Mesh(eq.geo, ringMat);
  eqMesh.name = 'ds-equator-trench';
  eqMesh.frustumCulled = false;
  group.add(eqMesh);

  const RIB_N = 84;
  const ribMesh = new THREE.InstancedMesh(eq.ribs, structMat, RIB_N);
  ribMesh.frustumCulled = false;
  {
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
    const north = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < RIB_N; i++) {
      const a = (i / RIB_N) * Math.PI * 2 + 0.013;
      const radial = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
      const tangent = new THREE.Vector3(-Math.sin(a), 0, Math.cos(a));
      q.setFromRotationMatrix(new THREE.Matrix4().makeBasis(tangent, radial, north));
      m4.compose(radial.clone().multiplyScalar(DS_RADIUS), q, one);
      ribMesh.setMatrixAt(i, m4);
    }
    ribMesh.instanceMatrix.needsUpdate = true;
  }
  group.add(ribMesh);

  /* ---- superlaser crater ---- */
  const dishGeo = buildDishShell();
  disposables.push(dishGeo);
  const dishMesh = new THREE.Mesh(dishGeo, dishMat);
  dishMesh.name = 'ds-dish';
  dishMesh.frustumCulled = false;
  group.add(dishMesh);

  const furn = buildDishFurniture(rng.fork(23));
  const dishCenter = recenter(furn.main);
  disposables.push(furn.main, furn.core);
  const dishFurnMesh = new THREE.Mesh(furn.main, structMat);
  dishFurnMesh.position.copy(dishCenter);
  group.add(dishFurnMesh);
  const coreCenter = recenter(furn.core);
  const coreMesh = new THREE.Mesh(furn.core, coreMat);
  coreMesh.position.copy(coreCenter);
  group.add(coreMesh);

  /* ---- macro features ---- */
  for (const f of buildFeatures(rng.fork(37))) {
    disposables.push(f.geo);
    const m = new THREE.Mesh(f.geo, structMat);
    m.position.copy(f.pos);
    m.quaternion.copy(f.quat);
    group.add(m);
  }

  /* ---- greeble rings ---- */
  const bigGeos = [
    ...greebleAtlas(seed + 101, 3, ['tower'], 11),
    ...greebleAtlas(seed + 102, 3, ['machinery'], 26),
    ...greebleAtlas(seed + 103, 2, ['antenna'], 15),
  ];
  const medGeos = [
    ...greebleAtlas(seed + 104, 3, ['machinery', 'vent'], 11),
    ...greebleAtlas(seed + 105, 2, ['tower', 'pipe'], 5),
    ...greebleAtlas(seed + 106, 2, ['antenna', 'vent'], 7),
  ];
  const smlGeos = [
    ...greebleAtlas(seed + 107, 3, ['plate', 'machinery'], 5),
    ...greebleAtlas(seed + 108, 3, ['vent', 'plate', 'pipe'], 3),
  ];
  for (const g of [...bigGeos, ...medGeos, ...smlGeos]) disposables.push(g);
  const rings: GreebleRing[] = [
    makeRing(bigGeos, gBigMat, 185, RING_BIG),
    makeRing(medGeos, gMedMat, 120, RING_MED),
    makeRing(smlGeos, gSmlMat, 96, RING_SMALL),
  ];
  for (const r of rings) for (const m of r.meshes) group.add(m);

  /* ---- streaming state ---- */
  const dirs = cellDirs();
  let lastCell = -1;
  let streaming = false;
  const _cd = new THREE.Vector3();
  const _pd = new THREE.Vector3();
  const _tx = new THREE.Vector3();
  const _tz = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _m4 = new THREE.Matrix4();
  const _scl = new THREE.Vector3();
  const _pos = new THREE.Vector3();
  const cosBig = Math.cos((RING_BIG + CELL_M) / DS_RADIUS);

  function place(ring: GreebleRing, gi: number, nx: number, ny: number, nz: number, roll: number, s: number, sink: number) {
    const mesh = ring.meshes[gi];
    const c = ring.counts[gi];
    if (c >= ring.cap) return;
    // the cell passed the boundary test, but the in-cell jitter can still have
    // pushed this instance into a hole — most importantly the trench module's
    // meridian corridor, which must stay completely clear.
    if (boundaryDistance(nx, ny, nz) < 260) return;
    _pd.set(nx, ny, nz);
    const r = DS_RADIUS + surfaceHeight(nx, ny, nz) - sink;
    _pos.set(nx * r, ny * r, nz * r);
    quatForDir(_pd, roll, _q);
    _scl.set(s, s, s);
    _m4.compose(_pos, _q, _scl);
    mesh.setMatrixAt(c, _m4);
    ring.counts[gi] = c + 1;
  }

  let lastRebuildMs = 0;
  function rebuild(camPos: THREE.Vector3) {
    const t0 = performance.now();
    for (const r of rings) r.counts.fill(0);
    _cd.copy(camPos).normalize();
    const nBig = rings[0].meshes.length, nMed = rings[1].meshes.length, nSml = rings[2].meshes.length;

    for (let c = 0; c < CELL_COUNT; c++) {
      const cx = dirs[c * 3], cy = dirs[c * 3 + 1], cz = dirs[c * 3 + 2];
      const dot = cx * _cd.x + cy * _cd.y + cz * _cd.z;
      if (dot < cosBig) continue;
      const distM = Math.acos(Math.min(1, dot)) * DS_RADIUS;
      if (boundaryDistance(cx, cy, cz) < 340) continue;

      // tangent frame for jittering inside the cell
      _pd.set(cx, cy, cz);
      _tx.set(0, 1, 0);
      if (Math.abs(cy) > 0.95) _tx.set(1, 0, 0);
      _tx.cross(_pd).normalize();
      _tz.copy(_tx).cross(_pd).normalize();
      const cellRad = CELL_M / DS_RADIUS;

      const h0 = hash3(c, 1, 7);
      if (h0 > 0.66 && distM < RING_BIG) {
        const hx = hash3(c, 2, 7) - 0.5, hz = hash3(c, 3, 7) - 0.5;
        const x = cx + (_tx.x * hx + _tz.x * hz) * cellRad;
        const y = cy + (_tx.y * hx + _tz.y * hz) * cellRad;
        const z = cz + (_tx.z * hx + _tz.z * hz) * cellRad;
        const l = Math.hypot(x, y, z);
        place(rings[0], Math.floor(hash3(c, 4, 7) * nBig) % nBig, x / l, y / l, z / l,
          hash3(c, 5, 7) * Math.PI * 2, 0.75 + hash3(c, 6, 7) * 0.7, 12);
      }

      if (distM < RING_MED) {
        for (let k = 0; k < 3; k++) {
          if (hash3(c, 20 + k, 3) < 0.34) continue;
          const hx = hash3(c, 30 + k, 3) - 0.5, hz = hash3(c, 40 + k, 3) - 0.5;
          const x = cx + (_tx.x * hx + _tz.x * hz) * cellRad;
          const y = cy + (_tx.y * hx + _tz.y * hz) * cellRad;
          const z = cz + (_tx.z * hx + _tz.z * hz) * cellRad;
          const l = Math.hypot(x, y, z);
          place(rings[1], Math.floor(hash3(c, 50 + k, 3) * nMed) % nMed, x / l, y / l, z / l,
            hash3(c, 60 + k, 3) * Math.PI * 2, 0.7 + hash3(c, 70 + k, 3) * 0.8, 6);
        }
      }

      if (distM < RING_SMALL) {
        for (let sy = 0; sy < 8; sy++) {
          for (let sx = 0; sx < 8; sx++) {
            const sc = sy * 8 + sx;
            if (hash3(c, 100 + sc, 9) < 0.62) continue;
            const hx = (sx + hash3(c, 200 + sc, 9)) / 8 - 0.5;
            const hz = (sy + hash3(c, 300 + sc, 9)) / 8 - 0.5;
            const x = cx + (_tx.x * hx + _tz.x * hz) * cellRad;
            const y = cy + (_tx.y * hx + _tz.y * hz) * cellRad;
            const z = cz + (_tx.z * hx + _tz.z * hz) * cellRad;
            const l = Math.hypot(x, y, z);
            place(rings[2], Math.floor(hash3(c, 400 + sc, 9) * nSml) % nSml, x / l, y / l, z / l,
              hash3(c, 500 + sc, 9) * Math.PI * 2, 0.6 + hash3(c, 600 + sc, 9) * 0.8, 3);
          }
        }
      }
    }
    for (const r of rings) {
      for (let i = 0; i < r.meshes.length; i++) {
        r.meshes[i].count = r.counts[i];
        r.meshes[i].instanceMatrix.needsUpdate = true;
      }
    }
    lastRebuildMs = performance.now() - t0;
  }

  function clearInstances() {
    for (const r of rings) for (const m of r.meshes) m.count = 0;
  }

  /* ---- public surface ---- */
  let damage = 0;
  const _cw = new THREE.Vector3();

  const ds: DeathStar = {
    group,
    shell,
    materials,
    ...({
      // debug helpers; additive to the contract, used by the QA harness
      _liveInstances: () => rings.map((r) => r.counts.reduce((a, b) => a + b, 0)),
      _rebuildMs: () => lastRebuildMs,
    } as object),
    update(_dt: number, time: number, camera: THREE.Camera) {
      camera.getWorldPosition(_cw);
      for (const m of materials) {
        setSurfaceUniform(m, 'uTime', time);
        setSurfaceUniform(m, 'uCamPos', _cw);
      }
      const alt = _cw.length() - DS_RADIUS;
      if (alt > STREAM_ALT) {
        if (streaming) { clearInstances(); streaming = false; lastCell = -1; }
        return;
      }
      streaming = true;
      const cell = dirToCell(_cd.copy(_cw).normalize());
      if (cell !== lastCell) { lastCell = cell; rebuild(_cw); }
    },
    setDamage(v: number) {
      damage = clamp(v, 0, 1);
      for (const m of materials) setSurfaceUniform(m, 'uDamage', damage);
    },
    setVisible(v: boolean) { group.visible = v; },
    dispose() {
      for (const d of disposables) d.dispose();
      for (const m of materials) m.dispose();
      group.clear();
    },
  };
  void damage;
  return ds;
}
