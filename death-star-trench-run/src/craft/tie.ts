import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RNG } from '../core/rng';
import { clamp, damp, dampV, dampQ, smoothstep, TAU, DEG } from '../core/mathx';
import { COL_IMP_LASER, COL_TIE_ENGINE } from '../core/constants';
import { GLSL_HASH, GLSL_NOISE } from '../shaders/lib';

/* =========================================================================
   TIE FIGHTER SQUADRON
   Procedural Imperial fighters: faceted ball cockpit, real solar-array wings,
   ion engine glow, arcade steering AI, poolable death FX.
   Everything is instanced: 3 hull draw calls + 1 ion + 1 debris, total.
   ========================================================================= */

/** Structural interface — the real FX class satisfies this; we never import it. */
export interface CombatFX {
  laser(origin: THREE.Vector3, dir: THREE.Vector3, opts?: any): void;
  explosion(pos: THREE.Vector3, radius: number, opts?: any): void;
  debrisBurst?(pos: THREE.Vector3, count: number, opts?: any): void;
  muzzleFlash?(pos: THREE.Vector3, dir: THREE.Vector3, color: THREE.Color, scale?: number): void;
  sparks?(pos: THREE.Vector3, normal: THREE.Vector3, count: number, color: THREE.Color, speed?: number): void;
}

export type TIEMode = 'formation' | 'pursue' | 'attack' | 'evade' | 'strafe' | 'flee' | 'dead';

export interface TIE {
  root: THREE.Object3D;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  quaternion: THREE.Quaternion;
  mode: TIEMode;
  hp: number;
  alive: boolean;
  variant: 'fighter' | 'interceptor' | 'advanced';
  /** formation slot offset in the leader's local frame; used in 'formation' mode */
  slot: THREE.Vector3;
  radius: number;
}

export interface TargetInfo {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  velocity: THREE.Vector3;
  radius: number;
}

export interface TIESquadron {
  group: THREE.Group;
  ties: TIE[];
  aliveCount: number;
  kills: number;
  spawn(pos: THREE.Vector3, forward: THREE.Vector3, count: number, opts?: { mode?: TIEMode; variant?: TIE['variant']; spread?: number; speed?: number }): TIE[];
  update(dt: number, time: number, target: TargetInfo, fx: CombatFX): void;
  damage(t: TIE, amount: number): boolean;
  kill(t: TIE, fx: CombatFX): void;
  hitTest(from: THREE.Vector3, to: THREE.Vector3): { tie: TIE; point: THREE.Vector3; normal: THREE.Vector3 } | null;
  breakOff(): void;
  setBounds(minAltitude: number | null): void;
  clear(): void;
  dispose(): void;
}

/* =========================================================================
   GEOMETRY KIT
   Attributes: aKind  0 painted hull · 1 solar cell · 2 glass · 3 bare metal
                      4 emissive cyan-white · 5 emissive amber/red
               aEmis  emissive strength 0..1
   ========================================================================= */

const _bm = new THREE.Matrix4();
const _be = new THREE.Euler();
const _bq = new THREE.Quaternion();
const _bv = new THREE.Vector3();
const UP_Y = new THREE.Vector3(0, 1, 0);

function tag(g: THREE.BufferGeometry, kind: number, emis = 0): THREE.BufferGeometry {
  const n = g.attributes.position.count;
  const k = new Float32Array(n); k.fill(kind);
  const e = new Float32Array(n); e.fill(emis);
  g.setAttribute('aKind', new THREE.BufferAttribute(k, 1));
  g.setAttribute('aEmis', new THREE.BufferAttribute(e, 1));
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  return g;
}

function place(g: THREE.BufferGeometry, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  if (rx || ry || rz) g.applyMatrix4(_bm.makeRotationFromEuler(_be.set(rx, ry, rz)));
  if (x || y || z) g.translate(x, y, z);
  return g;
}

function box(w: number, h: number, d: number, kind = 0, emis = 0) {
  return tag(new THREE.BoxGeometry(w, h, d), kind, emis);
}
/** Cylinder along +Y, centred. */
function cyl(r0: number, r1: number, h: number, seg = 8, kind = 0, emis = 0, open = false) {
  return tag(new THREE.CylinderGeometry(r1, r0, h, seg, 1, open), kind, emis);
}
/** Cylinder lying along +X. */
function cylX(r0: number, r1: number, h: number, seg = 8, kind = 0, emis = 0) {
  const g = cyl(r0, r1, h, seg, kind, emis);
  g.rotateZ(-Math.PI / 2);
  return g;
}
/** Cylinder lying along -Z (ship forward). */
function cylZ(r0: number, r1: number, h: number, seg = 8, kind = 0, emis = 0, open = false) {
  const g = cyl(r0, r1, h, seg, kind, emis, open);
  g.rotateX(-Math.PI / 2);
  return g;
}

function mergeAll(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const flat = parts.map((p) => (p.index ? p.toNonIndexed() : p));
  const m = mergeGeometries(flat, false);
  if (!m) throw new Error('tie.ts: merge failed');
  m.computeVertexNormals();
  m.computeBoundingSphere();
  return m;
}

/** Sit a part (built around origin, +Y = outward) on a sphere of radius r. */
function onSphere(g: THREE.BufferGeometry, r: number, phi: number, th: number, sink = 0.06) {
  _bv.set(Math.sin(phi) * Math.sin(th), Math.cos(phi), Math.sin(phi) * Math.cos(th));
  _bq.setFromUnitVectors(UP_Y, _bv);
  g.applyMatrix4(_bm.makeRotationFromQuaternion(_bq));
  g.translate(_bv.x * (r - sink), _bv.y * (r - sink), _bv.z * (r - sink));
  return g;
}

/**
 * Plated ball: latitude bands at slightly different radii joined by real step
 * walls, so the silhouette and the raking light both read the plate divisions.
 */
function facetedBall(r: number, segU: number, segV: number, rng: RNG, kind = 0): THREE.BufferGeometry {
  const pos: number[] = [];
  const radii: number[] = [];
  for (let j = 0; j < segV; j++) radii.push(r * (1 + 0.030 * Math.round(rng.range(-1.75, 1.75))));
  const P = (rad: number, phi: number, th: number) => [
    Math.sin(phi) * Math.sin(th) * rad, Math.cos(phi) * rad, Math.sin(phi) * Math.cos(th) * rad,
  ];
  const tri = (a: number[], b: number[], c: number[]) => { pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]); };
  // reversed winding (a,d,c,b) so faces point outward
  const quad = (a: number[], b: number[], c: number[], d: number[]) => { tri(a, d, c); tri(a, c, b); };

  for (let j = 0; j < segV; j++) {
    const phi0 = (j / segV) * Math.PI, phi1 = ((j + 1) / segV) * Math.PI;
    const rad = radii[j];
    for (let i = 0; i < segU; i++) {
      const t0 = (i / segU) * TAU, t1 = ((i + 1) / segU) * TAU;
      const a = P(rad, phi0, t0), b = P(rad, phi0, t1), c = P(rad, phi1, t1), d = P(rad, phi1, t0);
      if (j === 0) tri(a, d, c);
      else if (j === segV - 1) tri(a, c, b);
      else quad(a, b, c, d);
    }
  }
  for (let j = 0; j < segV - 1; j++) {
    const r0 = radii[j], r1 = radii[j + 1];
    if (Math.abs(r0 - r1) < 1e-4) continue;
    const phi = ((j + 1) / segV) * Math.PI;
    for (let i = 0; i < segU; i++) {
      const t0 = (i / segU) * TAU, t1 = ((i + 1) / segU) * TAU;
      quad(P(r0, phi, t0), P(r0, phi, t1), P(r1, phi, t1), P(r1, phi, t0));
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.computeVertexNormals();
  return tag(g, kind);
}

/** Flip any triangle whose face normal points back at `c` (works for convex parts). */
function orientOutward(g: THREE.BufferGeometry, cx: number, cy: number, cz: number) {
  const a = (g.attributes.position as THREE.BufferAttribute).array as Float32Array;
  for (let i = 0; i < a.length; i += 9) {
    const ax = a[i], ay = a[i + 1], az = a[i + 2];
    const bx = a[i + 3], by = a[i + 4], bz = a[i + 5];
    const cx2 = a[i + 6], cy2 = a[i + 7], cz2 = a[i + 8];
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx2 - ax, e2y = cy2 - ay, e2z = cz2 - az;
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const mx = (ax + bx + cx2) / 3 - cx, my = (ay + by + cy2) / 3 - cy, mz = (az + bz + cz2) / 3 - cz;
    if (nx * mx + ny * my + nz * mz < 0) {
      a[i + 3] = cx2; a[i + 4] = cy2; a[i + 5] = cz2;
      a[i + 6] = bx; a[i + 7] = by; a[i + 8] = bz;
    }
  }
  g.computeVertexNormals();
  return g;
}

/** Truncated pyramid — a solar cell that catches the key light on its bevels. */
function cellFrustum(w: number, h: number, depth: number, inset: number, kind: number): THREE.BufferGeometry {
  const hw = w / 2, hh = h / 2, iw = hw - inset, ih = hh - inset;
  const p: number[] = [];
  const v = (x: number, y: number, z: number) => { p.push(z, y, x); };   // (w along Z, h along Y, depth along X)
  const q = (a: number[], b: number[], c: number[], d: number[]) => {
    v(a[0], a[1], a[2]); v(b[0], b[1], b[2]); v(c[0], c[1], c[2]);
    v(a[0], a[1], a[2]); v(c[0], c[1], c[2]); v(d[0], d[1], d[2]);
  };
  const b0 = [-hw, -hh, 0], b1 = [hw, -hh, 0], b2 = [hw, hh, 0], b3 = [-hw, hh, 0];
  const t0 = [-iw, -ih, depth], t1 = [iw, -ih, depth], t2 = [iw, ih, depth], t3 = [-iw, ih, depth];
  q(t0, t1, t2, t3);            // top face
  q(b0, t0, t3, b3);            // -w side
  q(b1, b2, t2, t1);            // +w side
  q(b0, b1, t1, t0);            // -h side
  q(b3, t3, t2, b2);            // +h side
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(p), 3));
  orientOutward(g, depth * 0.5, 0, 0);
  return tag(g, kind);
}

/* ---------------------------------------------------------------- wings */

type Pt = [number, number];   // shape space: u = forward (-Z), v = up (+Y)

const WING_OUTLINE: Record<string, Pt[]> = {
  fighter: [[0, 3.5], [-2.62, 1.78], [-2.62, -1.78], [0, -3.5], [2.62, -1.78], [2.62, 1.78]],
  interceptor: [[-2.25, 3.62], [-2.62, 0], [-2.25, -3.62], [2.95, -1.52], [0.62, 0], [2.95, 1.52]],
  advanced: [[0.35, 3.42], [-2.35, 2.02], [-2.60, -2.02], [0.35, -3.42], [2.70, -1.62], [2.70, 1.62]],
};

function scalePts(p: Pt[], s: number): Pt[] { return p.map(([u, v]) => [u * s, v * s] as Pt); }

function shapeOf(pts: Pt[]): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) s.lineTo(pts[i][0], pts[i][1]);
  s.closePath();
  return s;
}

function pointInPoly(pts: Pt[], u: number, v: number): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > v) !== (yj > v) && u < ((xj - xi) * (v - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function spanAt(pts: Pt[], v: number): [number, number] | null {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > v) !== (yj > v)) {
      const u = ((xj - xi) * (v - yi)) / (yj - yi) + xi;
      if (u < lo) lo = u;
      if (u > hi) hi = u;
    }
  }
  return hi > lo ? [lo, hi] : null;
}

/**
 * One solar-array wing in RIGHT-wing local space:
 * origin at the panel centre, +X outboard (thickness), +Y up, -Z forward.
 */
function buildWing(variant: 'fighter' | 'interceptor' | 'advanced', rng: RNG): THREE.BufferGeometry {
  const outline = WING_OUTLINE[variant];
  const TH = 0.40, HALF = TH / 2;   // rim faces at +-0.20
  const parts: THREE.BufferGeometry[] = [];

  // shape space (u,v) -> world: rotateY(+90) maps (u,v,c) -> (c, v, -u)
  const toWorld = (g: THREE.BufferGeometry) => { g.rotateY(Math.PI / 2); return g; };

  // --- outer frame: thick chamfered rim with a hole ---
  const inner = scalePts(outline, 0.795);
  const frameShape = shapeOf(outline);
  frameShape.holes.push(new THREE.Path(inner.map(([u, v]) => new THREE.Vector2(u, v))));
  const frame = new THREE.ExtrudeGeometry(frameShape, {
    depth: TH, bevelEnabled: true, bevelThickness: 0.095, bevelSize: 0.095, bevelSegments: 1, curveSegments: 1,
  });
  parts.push(place(toWorld(tag(frame, 0)), -HALF, 0, 0));

  // --- dark recessed backing: this is what shows between the dividers ---
  const backShape = shapeOf(scalePts(outline, 0.82));
  const back = new THREE.ExtrudeGeometry(backShape, { depth: 0.18, bevelEnabled: false, curveSegments: 1 });
  parts.push(place(toWorld(tag(back, 1)), -0.09, 0, 0));

  /* --- 3 x 6 cell grid: dark cells + thin bright raised dividers --------- */
  const cellPoly = scalePts(outline, 0.775);
  const ROWS = 6, COLS = 3;
  let vLo = Infinity, vHi = -Infinity;
  for (const [, v] of cellPoly) { vLo = Math.min(vLo, v); vHi = Math.max(vHi, v); }
  const vMin = vLo * 0.80, vMax = vHi * 0.80;
  const rowH = (vMax - vMin) / ROWS;
  /** narrowest horizontal span the row touches, so all 3 cells stay inside */
  const rowSpan = (v0: number, v1: number): [number, number] | null => {
    const a = spanAt(cellPoly, v0), b = spanAt(cellPoly, v1), c = spanAt(cellPoly, (v0 + v1) / 2);
    if (!a || !b || !c) return null;
    const lo = Math.max(a[0], b[0], c[0]), hi = Math.min(a[1], b[1], c[1]);
    return hi - lo > 0.4 ? [lo, hi] : null;
  };
  const LX = 0.145, LT = 0.115;                 // divider centre / thickness in X
  // interior horizontal dividers
  for (let r = 1; r < ROWS; r++) {
    const v = vMin + rowH * r;
    const sp = rowSpan(v - rowH * 0.5, v + rowH * 0.5);
    if (!sp) continue;
    parts.push(place(box(LT, 0.085, sp[1] - sp[0], 0), LX, v, -(sp[0] + sp[1]) / 2));
  }
  // interior vertical dividers + the cells themselves
  for (let r = 0; r < ROWS; r++) {
    const vc = vMin + rowH * (r + 0.5);
    const sp = rowSpan(vc - rowH * 0.5, vc + rowH * 0.5);
    if (!sp) continue;
    const colW = (sp[1] - sp[0]) / COLS;
    for (let c = 0; c < COLS; c++) {
      const uc = sp[0] + colW * (c + 0.5);
      const w = colW * 0.90, h = rowH * 0.88;
      if (!pointInPoly(cellPoly, uc, vc)) continue;
      parts.push(place(cellFrustum(w, h, 0.05, Math.min(w, h) * 0.10, 1), 0.09, vc, -uc));
    }
    for (let c = 1; c < COLS; c++) {
      parts.push(place(box(LT, rowH * 0.98, 0.085, 0), LX, vc, -(sp[0] + colW * c)));
    }
  }

  // --- 6 radial spars, hull-coloured, proud on both faces ---
  for (const [u, v] of outline) {
    const z = -u * 0.86, y = v * 0.86;
    const len = Math.hypot(y, z);
    if (len < 0.2) continue;
    parts.push(place(box(0.46, 0.155, len, 0), 0, y / 2, z / 2, Math.atan2(-y, z), 0, 0));
  }

  // --- back-side ribbing + a concentric structural ring ---
  const ringOuter = shapeOf(scalePts(outline, 0.56));
  ringOuter.holes.push(new THREE.Path(scalePts(outline, 0.44).map(([u, v]) => new THREE.Vector2(u, v))));
  const ring = new THREE.ExtrudeGeometry(ringOuter, { depth: 0.11, bevelEnabled: false, curveSegments: 1 });
  parts.push(place(toWorld(tag(ring, 0)), -HALF - 0.10, 0, 0));
  for (let i = 0; i < 2; i++) {
    const y = (i - 0.5) * 2.6;
    const sp = spanAt(scalePts(outline, 0.78), y);
    if (!sp) continue;
    parts.push(place(box(0.10, 0.22, (sp[1] - sp[0]) * 0.94, 3), -HALF - 0.05, y, -(sp[0] + sp[1]) / 2));
  }

  // --- hub (inboard) + outboard boss ---
  parts.push(place(cylX(0.66, 0.52, 0.40, 10, 0), -HALF - 0.19, 0, 0));
  parts.push(place(cylX(0.40, 0.40, 0.18, 8, 3), -HALF - 0.46, 0, 0));
  parts.push(place(cylX(0.42, 0.32, 0.16, 8, 0), HALF + 0.07, 0, 0));
  parts.push(place(cylX(0.20, 0.20, 0.09, 6, 4, 0.30), HALF + 0.16, 0, 0));
  // small warning stripe near the hub
  parts.push(place(box(0.05, 0.09, 0.52, 5, 0.55), HALF + 0.02, -0.90, 0));

  const g = mergeAll(parts);
  if (variant === 'advanced') {
    // bend the panel: the further from the midline, the more it cants inboard
    const p = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i);
      const k = Math.min(1, Math.abs(y) / 3.4);
      p.setX(i, p.getX(i) - Math.pow(k, 1.35) * 0.95);
      p.setZ(i, p.getZ(i) + Math.pow(k, 1.7) * 0.55);
    }
    p.needsUpdate = true;
    g.computeVertexNormals();
  }
  return g;
}

/** Mirror a right-wing geometry to the left, fixing winding + normals. */
function mirrorX(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = src.clone();
  const p = g.attributes.position as THREE.BufferAttribute;
  const n = g.attributes.normal as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) { p.setX(i, -p.getX(i)); n.setX(i, -n.getX(i)); }
  // reverse winding of every triangle (geometry is non-indexed after mergeAll)
  const arrs = [p.array as Float32Array, n.array as Float32Array];
  for (const a of arrs) {
    for (let i = 0; i < p.count; i += 3) {
      for (let c = 0; c < 3; c++) {
        const t = a[(i + 1) * 3 + c]; a[(i + 1) * 3 + c] = a[(i + 2) * 3 + c]; a[(i + 2) * 3 + c] = t;
      }
    }
  }
  for (const name of ['aKind', 'aEmis'] as const) {
    const at = g.attributes[name] as THREE.BufferAttribute;
    const a = at.array as Float32Array;
    for (let i = 0; i < at.count; i += 3) { const t = a[i + 1]; a[i + 1] = a[i + 2]; a[i + 2] = t; }
    at.needsUpdate = true;
  }
  p.needsUpdate = true; n.needsUpdate = true;
  return g;
}

/* ---------------------------------------------------------------- cockpit */

const VIEWPORT: Pt[] = [
  [-0.80, 0.14], [-0.52, 0.44], [0.52, 0.44], [0.80, 0.14], [0.50, -0.44], [-0.50, -0.44],
];

/** Ball cockpit + chin guns + ion housings, in ship space (forward -Z, up +Y). */
function buildCockpit(variant: 'fighter' | 'interceptor' | 'advanced', R: number, rng: RNG): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(facetedBall(R, 18, 11, rng, 0));

  // equatorial + meridian belts — hard plate divisions on the silhouette
  parts.push(tag(new THREE.TorusGeometry(R * 0.985, 0.080, 3, 16), 3).rotateX(Math.PI / 2));

  /* ---- recessed hexagonal viewport ---- */
  const vpScale = R / 1.70;
  const vpOuter = scalePts(VIEWPORT, vpScale);
  const rimShape = shapeOf(scalePts(VIEWPORT, vpScale * 1.20));
  rimShape.holes.push(new THREE.Path(vpOuter.map(([u, v]) => new THREE.Vector2(u, v))));
  const rim = new THREE.ExtrudeGeometry(rimShape, {
    depth: 0.42, bevelEnabled: true, bevelThickness: 0.055, bevelSize: 0.055, bevelSegments: 1, curveSegments: 1,
  });
  // shape space u=right, v=up, extrude +Z => push it into the ball nose
  parts.push(place(tag(rim, 0), 0, -0.02, -(R - 0.14) - 0.42));
  // sunken hex frame one step deeper
  const inShape = shapeOf(scalePts(VIEWPORT, vpScale * 1.0));
  inShape.holes.push(new THREE.Path(scalePts(VIEWPORT, vpScale * 0.86).map(([u, v]) => new THREE.Vector2(u, v))));
  const inFrame = new THREE.ExtrudeGeometry(inShape, { depth: 0.20, bevelEnabled: false, curveSegments: 1 });
  parts.push(place(tag(inFrame, 3), 0, -0.02, -(R - 0.05) - 0.20));
  // tinted glass
  const glass = new THREE.ExtrudeGeometry(shapeOf(scalePts(VIEWPORT, vpScale * 0.87)), { depth: 0.08, bevelEnabled: false, curveSegments: 1 });
  parts.push(place(tag(glass, 2, 0.18), 0, -0.02, -(R - 0.02) - 0.08));
  // mullions across the glass so it does not read as one blank hex
  for (const mx of [-0.30, 0.30]) {
    parts.push(place(box(0.045, 0.72 * vpScale, 0.10, 0), mx * vpScale, -0.02, -(R + 0.045)));
  }
  parts.push(place(box(1.30 * vpScale, 0.045, 0.09, 0), 0, 0.16 * vpScale, -(R + 0.045)));
  // interior glow strip peeking out under the glass
  parts.push(place(box(0.72 * vpScale, 0.05, 0.05, 4, 0.42), 0, -0.38 * vpScale - 0.02, -(R + 0.035)));

  /* ---- raised brow over the window ---- */
  const brow = tag(new THREE.TorusGeometry(0.98 * vpScale, 0.085, 4, 14, Math.PI * 0.92), 0);
  brow.rotateZ(Math.PI * 0.04);
  parts.push(place(brow, 0, 0.30 * vpScale, -(R - 0.30), 0.22, 0, 0));
  parts.push(place(box(1.45 * vpScale, 0.16, 0.34, 0, 0), 0, 0.62 * vpScale, -(R - 0.42)));

  /* ---- chin gun block + 4 barrels ---- */
  const cy = -0.62 * R, cz = -(R * 0.80);
  parts.push(place(box(1.72 * vpScale, 0.60, 1.15, 0, 0), 0, cy - 0.06, cz - 0.05));
  parts.push(place(box(1.42 * vpScale, 0.20, 0.52, 3, 0), 0, cy - 0.32, cz + 0.10));
  parts.push(place(box(1.34 * vpScale, 0.24, 0.34, 3, 0), 0, cy + 0.32, cz - 0.50));
  for (const bx of [-0.62, -0.27, 0.27, 0.62]) {
    const x = bx * vpScale;
    const outer = Math.abs(bx) > 0.4;
    const len = outer ? 1.05 : 1.34;
    parts.push(place(cylZ(0.062, 0.050, len, 8, 3), x, cy, cz - 0.60 - len / 2));
    parts.push(place(cylZ(0.145, 0.145, 0.26, 8, 0), x, cy, cz - 0.66));
    parts.push(place(cylZ(0.085, 0.070, 0.09, 8, 4, 0.30), x, cy, cz - 0.60 - len - 0.03));
  }

  /* ---- rear ion emitter housings ---- */
  const rz = R * 0.86;
  for (const [ex, ey] of [[0, 0.60], [-0.55, -0.34], [0.55, -0.34]] as Pt[]) {
    const x = ex * vpScale, y = ey * vpScale;
    // open-ended nozzle collar so the ion glow can shine straight out of it
    parts.push(place(cylZ(0.42, 0.50, 0.36, 10, 0, 0, true), x, y, rz + 0.08));
    parts.push(place(cylZ(0.50, 0.56, 0.10, 10, 3), x, y, rz - 0.10));
    parts.push(place(cylZ(0.38, 0.38, 0.05, 10, 4, 0.40), x, y, rz - 0.03));
  }
  parts.push(place(box(1.5 * vpScale, 0.5, 0.26, 3, 0), 0, -0.05, rz + 0.18));

  /* ---- surface greebles: hatches, sensors, warning strips ---- */
  const gr = rng.fork(7);
  for (let i = 0; i < 5; i++) {
    const phi = gr.range(0.45, 2.65), th = gr.range(0, TAU);
    const k = gr.next();
    if (k < 0.45) parts.push(onSphere(box(gr.range(0.30, 0.62), 0.10, gr.range(0.28, 0.55), 3), R, phi, th, 0.02));
    else if (k < 0.75) parts.push(onSphere(cyl(0.16, 0.13, 0.16, 6, 3), R, phi, th, 0.03));
    else parts.push(onSphere(box(gr.range(0.20, 0.34), 0.05, 0.09, 5, 0.5), R, phi, th, 0.01));
  }
  // upper hatch ring
  parts.push(onSphere(cyl(0.62, 0.52, 0.16, 12, 0), R, 0.34, 0.7, 0.05));
  parts.push(onSphere(cyl(0.38, 0.34, 0.10, 8, 3), R, 0.34, 0.7, -0.06));
  // hexagonal pylon collars either side
  for (const sx of [-1, 1]) {
    parts.push(place(cylX(0.98, 0.82, 0.26, 6, 0), sx * (R * 0.90), 0, 0, 0, 0, 0));
    parts.push(place(cylX(0.74, 0.74, 0.14, 6, 3), sx * (R * 0.99), 0, 0));
  }
  // two meridian ribs so the sphere reads as plated structure
  for (const ang of [0.42, -0.42]) {
    const rib = tag(new THREE.TorusGeometry(R * 0.99, 0.055, 3, 10, Math.PI * 1.05), 3);
    rib.rotateZ(-Math.PI * 0.52);
    parts.push(place(rib, 0, 0, 0, 0, ang, 0));
  }

  if (variant === 'advanced') {
    // dorsal fin
    const finPts: Pt[] = [[0.30, -0.05], [-0.10, 1.15], [-1.05, 1.30], [-1.65, -0.05]];
    const fin = new THREE.ExtrudeGeometry(shapeOf(finPts), { depth: 0.14, bevelEnabled: true, bevelThickness: 0.045, bevelSize: 0.045, bevelSegments: 1, curveSegments: 1 });
    fin.rotateY(Math.PI / 2);          // (u,v,c) -> (c, v, -u): u = forward
    parts.push(place(tag(fin, 0), -0.07, R * 0.88, 0.1));
    parts.push(place(box(0.46, 0.24, 1.7, 0, 0), 0, R * 0.93, 0.35));
    // heavier chin armour
    parts.push(place(box(1.9, 0.30, 0.7, 0, 0), 0, cy - 0.28, cz - 0.1));
  }
  if (variant === 'interceptor') {
    // extra cheek intakes
    for (const sx of [-1, 1]) {
      parts.push(place(box(0.34, 0.46, 0.9, 3, 0), sx * R * 0.72, -0.15, -R * 0.45));
      parts.push(place(box(0.12, 0.16, 0.34, 5, 0.5), sx * R * 0.86, -0.15, -R * 0.5));
    }
  }
  return mergeAll(parts);
}

/* ---------------------------------------------------------------- pylons */

function buildPylon(x0: number, x1: number, rng: RNG): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const len = x1 - x0, mid = (x0 + x1) / 2;
  parts.push(place(cylX(0.78, 0.58, 0.44, 8, 0), x0 + 0.16, 0, 0));         // root collar
  parts.push(place(cylX(0.44, 0.44, len, 6, 0), mid, 0, 0));                // hex strut
  parts.push(place(box(len * 0.86, 0.62, 0.34, 3, 0), mid, 0, 0));          // fairing
  parts.push(place(cylX(0.34, 0.34, len * 0.62, 6, 3), mid + len * 0.08, 0.30, 0));
  parts.push(place(cylX(0.60, 0.72, 0.46, 8, 0), x1 - 0.18, 0, 0));         // outer cap
  // bolts around both collars
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU;
    for (const xx of [x0 + 0.30, x1 - 0.32]) {
      parts.push(place(cyl(0.06, 0.06, 0.10, 5, 3), xx, Math.cos(a) * 0.56, Math.sin(a) * 0.56, 0, 0, Math.PI / 2));
    }
  }
  // vents along the strut
  for (let i = 0; i < 2; i++) {
    const xx = x0 + len * (0.30 + i * 0.26);
    parts.push(place(box(len * 0.11, 0.12, 0.50, 3, 0), xx, 0.42, 0));
    parts.push(place(box(len * 0.11, 0.12, 0.50, 3, 0), xx, -0.42, 0));
  }
  parts.push(place(box(len * 0.40, 0.05, 0.13, 5, 0.5), mid, 0.46, 0.20));
  return mergeAll(parts);
}

/* ---------------------------------------------------------------- variants */

interface VariantBuild {
  geo: THREE.BufferGeometry;
  wing: THREE.BufferGeometry;   // standalone right-wing geo, for debris
  muzzles: THREE.Vector3[];
  ionOffset: THREE.Matrix4;
  radius: number;
  tris: number;
}

const VARIANTS: TIE['variant'][] = ['fighter', 'interceptor', 'advanced'];

function buildVariant(variant: TIE['variant'], seed: number): VariantBuild {
  const rng = new RNG(seed);
  const R = variant === 'advanced' ? 1.94 : 1.70;
  const wingX = variant === 'advanced' ? 4.20 : 4.05;
  const cant = variant === 'interceptor' ? 0.075 : 0.045;

  const parts: THREE.BufferGeometry[] = [];
  parts.push(buildCockpit(variant, R, rng));
  parts.push(buildPylon(R * 0.88, wingX - 0.30, rng));
  parts.push(place(buildPylon(R * 0.88, wingX - 0.30, rng), 0, 0, 0, 0, Math.PI, 0));

  const wingR = buildWing(variant, rng);
  const right = wingR.clone();
  right.rotateZ(cant);
  right.translate(wingX, 0, 0);
  parts.push(right);
  const left = mirrorX(wingR);
  left.rotateZ(-cant);
  left.translate(-wingX, 0, 0);
  parts.push(left);

  const geo = mergeAll(parts);
  const vp = R / 1.70;
  const cy = -0.62 * R, cz = -(R * 0.80);
  const muzzles = [-0.62, -0.27, 0.27, 0.62].map((bx) => {
    const len = Math.abs(bx) > 0.4 ? 1.05 : 1.34;
    return new THREE.Vector3(bx * vp, cy, cz - 0.63 - len);
  });
  // clear of the ball surface, and scaled so the emitters line up on every variant
  const ionOffset = new THREE.Matrix4().makeTranslation(0, 0, R * 1.02)
    .multiply(new THREE.Matrix4().makeScale(vp, vp, 1));
  const tris = geo.attributes.position.count / 3;
  return { geo, wing: wingR, muzzles, ionOffset, radius: variant === 'advanced' ? 3.9 : variant === 'interceptor' ? 3.4 : 3.6, tris };
}

/* ---------------------------------------------------------------- ion glow */

function buildIonGeometry(): THREE.BufferGeometry {
  const pos: number[] = [], aT: number[] = [], aR: number[] = [];
  const emit = (x: number, y: number) => {
    const SEG = 9;
    const cone = (r0: number, r1: number, len: number, rTag: number) => {
      for (let i = 0; i < SEG; i++) {
        const a0 = (i / SEG) * TAU, a1 = ((i + 1) / SEG) * TAU;
        const p = [
          [x + Math.cos(a0) * r0, y + Math.sin(a0) * r0, 0, 0],
          [x + Math.cos(a1) * r0, y + Math.sin(a1) * r0, 0, 0],
          [x + Math.cos(a1) * r1, y + Math.sin(a1) * r1, len, 1],
          [x + Math.cos(a0) * r1, y + Math.sin(a0) * r1, len, 1],
        ];
        for (const [i0, i1, i2] of [[0, 1, 2], [0, 2, 3]]) {
          for (const k of [i0, i1, i2]) { pos.push(p[k][0], p[k][1], p[k][2]); aT.push(p[k][3]); aR.push(rTag); }
        }
      }
    };
    cone(0.26, 0.46, 1.65, 0.55);        // core wash
    cone(0.34, 0.86, 2.60, 0.88);        // outer wash
    // hot disc at the nozzle
    for (let i = 0; i < SEG; i++) {
      const a0 = (i / SEG) * TAU, a1 = ((i + 1) / SEG) * TAU;
      pos.push(x, y, 0.02); aT.push(0); aR.push(0);
      pos.push(x + Math.cos(a0) * 0.30, y + Math.sin(a0) * 0.30, 0.02); aT.push(0); aR.push(1);
      pos.push(x + Math.cos(a1) * 0.30, y + Math.sin(a1) * 0.30, 0.02); aT.push(0); aR.push(1);
    }
  };
  emit(0, 0.60); emit(-0.55, -0.34); emit(0.55, -0.34);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('aT', new THREE.BufferAttribute(new Float32Array(aT), 1));
  g.setAttribute('aR', new THREE.BufferAttribute(new Float32Array(aR), 1));
  g.computeBoundingSphere();
  return g;
}

function createIonMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color().copy(COL_TIE_ENGINE) },
      uStrength: { value: 8.5 },
    },
    vertexShader: /* glsl */`
      attribute float aT;
      attribute float aR;
      attribute vec2 aIon;
      varying float vT; varying float vR; varying float vSeed; varying float vPow;
      void main(){
        vT = aT; vR = aR; vSeed = aIon.x; vPow = aIon.y;
        vec4 mv = vec4(position, 1.0);
        #ifdef USE_INSTANCING
          mv = instanceMatrix * mv;
        #endif
        mv = modelViewMatrix * mv;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */`
      precision highp float;
      uniform float uTime; uniform vec3 uColor; uniform float uStrength;
      varying float vT; varying float vR; varying float vSeed; varying float vPow;
      void main(){
        float t = clamp(vT, 0.0, 1.0);
        float fall = pow(1.0 - t, 1.9);
        float flick = 0.80
          + 0.16 * sin(uTime * 37.0 + vSeed * 17.3) * cos(uTime * 23.0 + vSeed * 41.1)
          + 0.10 * sin(uTime * 91.0 + vSeed * 7.7);
        vec3 col = mix(uColor, vec3(1.0), pow(1.0 - t, 3.0) * 0.9);
        float a = fall * pow(max(1.0 - vR * 0.86, 0.0), 2.0);
        gl_FragColor = vec4(col * a * uStrength * flick * max(vPow, 0.0), 1.0);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: true,
  });
}

/* ---------------------------------------------------------------- hull material */

interface HullUniforms {
  uTime: { value: number };
  uHull: { value: THREE.Color };
  uCell: { value: THREE.Color };
  uGlass: { value: THREE.Color };
  uMetal: { value: THREE.Color };
  uEmisA: { value: THREE.Color };
  uEmisB: { value: THREE.Color };
  uEmisStr: { value: number };
  uPanel: { value: number };
  uGrime: { value: number };
}

function createTIEHullMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0x000000,
    roughness: 0.6,
    metalness: 0.55,
    flatShading: true,
  });
  const uniforms: HullUniforms = {
    uTime: { value: 0 },
    uHull: { value: new THREE.Color(0.520, 0.552, 0.590) },
    uCell: { value: new THREE.Color(0.052, 0.064, 0.100) },
    uGlass: { value: new THREE.Color(0.022, 0.028, 0.038) },
    uMetal: { value: new THREE.Color(0.335, 0.352, 0.378) },
    uEmisA: { value: new THREE.Color(0.55, 0.86, 1.0) },
    uEmisB: { value: new THREE.Color(1.0, 0.34, 0.10) },
    uEmisStr: { value: 1.8 },
    uPanel: { value: 1.9 },
    uGrime: { value: 0.42 },
  };
  (mat as any).userData.uniforms = uniforms;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        attribute float aKind;
        attribute float aEmis;
        #ifdef USE_INSTANCING
          attribute vec4 aInst;
        #endif
        varying float vKind; varying float vEmis; varying vec3 vObj; varying vec4 vInst;
      `)
      .replace('#include <begin_vertex>', /* glsl */`
        #include <begin_vertex>
        vKind = aKind; vEmis = aEmis; vObj = position;
        #ifdef USE_INSTANCING
          vInst = aInst;
        #else
          vInst = vec4(0.0, 0.0, 0.0, 1.0);
        #endif
      `);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        varying float vKind; varying float vEmis; varying vec3 vObj; varying vec4 vInst;
        uniform float uTime, uEmisStr, uPanel, uGrime;
        uniform vec3 uHull, uCell, uGlass, uMetal, uEmisA, uEmisB;
        ${GLSL_HASH}
        ${GLSL_NOISE}
        float tiePanel(vec3 p, vec3 a, float s){
          vec2 gx = abs(fract(p.zy*s)-0.5), gy = abs(fract(p.xz*s)-0.5), gz = abs(fract(p.xy*s)-0.5);
          float dx = min(gx.x,gx.y), dy = min(gy.x,gy.y), dz = min(gz.x,gz.y);
          float w = 0.030;
          return a.x*(1.0-smoothstep(w, w+max(fwidth(dx)*1.5, 0.008), dx))
               + a.y*(1.0-smoothstep(w, w+max(fwidth(dy)*1.5, 0.008), dy))
               + a.z*(1.0-smoothstep(w, w+max(fwidth(dz)*1.5, 0.008), dz));
        }
      `)
      .replace('#include <color_fragment>', /* glsl */`
        #include <color_fragment>
        {
          vec3 P = vObj;
          vec3 ON = normalize(cross(dFdx(P), dFdy(P)));
          vec3 an = abs(ON); an /= max(an.x+an.y+an.z, 1e-4);
          float sd = vInst.x;
          vec3 base;
          if (vKind < 0.5)      base = uHull;
          else if (vKind < 1.5) base = uCell;
          else if (vKind < 2.5) base = uGlass;
          else if (vKind < 3.5) base = uMetal;
          else                  base = vec3(0.06);

          if (vKind < 0.5 || (vKind > 2.5 && vKind < 3.5)) {
            vec3 aniso = vec3(1.0, 0.58, 0.78);
            float pl  = tiePanel(P*aniso, an, uPanel);
            float pl2 = tiePanel(P*aniso, an, uPanel*0.37);
            float plate = hash13(floor(P*aniso*uPanel*0.99) + sd*13.0);
            float bigPlate = hash13(floor(P*aniso*uPanel*0.37) + sd*4.0);
            base *= 0.90 + 0.15*plate + 0.09*bigPlate;
            base *= 1.0 - 0.40*pl - 0.22*pl2;
            // edge wear: bare metal showing along a subset of the seams
            float wear = step(0.62, hash13(floor(P*aniso*uPanel) + sd*3.0 + 5.0));
            base += vec3(0.14,0.148,0.158) * pl * wear;
            float gr = fbm3(P*vec3(1.05,1.05,0.28) + sd*7.0, 4, 2.2, 0.55);
            base *= mix(1.0, 0.62+0.56*gr, uGrime);
          } else if (vKind < 1.5) {
            float c = hash13(floor(P*2.6) + sd*5.0);
            base *= 0.62 + 0.90*c;
            base += vec3(0.012,0.020,0.042) * (0.4 + 0.6*c);
            base *= 1.0 - 0.35*tiePanel(P, an, 4.4);
          }
          float dmg = vInst.y;
          if (dmg > 0.001) {
            float sc = fbm3(P*2.1 + sd*3.0, 3, 2.3, 0.5);
            base *= 1.0 - 0.78*dmg*smoothstep(0.34, 0.72, sc);
          }
          diffuseColor.rgb *= base * clamp(vInst.w, 0.0, 1.0);
        }
      `)
      .replace('#include <roughnessmap_fragment>', /* glsl */`
        #include <roughnessmap_fragment>
        {
          float r = 0.60;
          if (vKind < 0.5) r = 0.55;
          else if (vKind < 1.5) r = 0.27;
          else if (vKind < 2.5) r = 0.09;
          else if (vKind < 3.5) r = 0.36;
          float n = vnoise3(vObj*5.5 + vInst.x*11.0);
          roughnessFactor = clamp(r*(0.80+0.44*n), 0.035, 1.0);
        }
      `)
      .replace('#include <metalnessmap_fragment>', /* glsl */`
        #include <metalnessmap_fragment>
        {
          float m = 0.45;
          if (vKind < 0.5) m = 0.40;
          else if (vKind < 1.5) m = 0.62;
          else if (vKind < 2.5) m = 0.85;
          else if (vKind < 3.5) m = 0.88;
          metalnessFactor = m;
        }
      `)
      .replace('#include <emissivemap_fragment>', /* glsl */`
        #include <emissivemap_fragment>
        {
          float fade = clamp(vInst.w, 0.0, 1.0);
          if (vKind > 3.5 && vKind < 4.5) {
            float fl = 0.86 + 0.14*sin(uTime*6.0 + vInst.x*30.0);
            totalEmissiveRadiance += uEmisA * (vEmis * uEmisStr * fl * fade);
          } else if (vKind > 4.5) {
            float fl = 0.5 + 0.5*step(0.5, fract(uTime*1.3 + vInst.x*3.0));
            totalEmissiveRadiance += uEmisB * (vEmis * uEmisStr * fl * fade);
          } else if (vKind > 1.5 && vKind < 2.5) {
            // faint cockpit interior spill, brightest at the bottom of the pane
            float g = smoothstep(0.35, -0.95, vObj.y) * 0.92 + 0.08;
            totalEmissiveRadiance += uEmisA * (vEmis * 0.85 * g * fade);
          }
          if (vInst.y > 0.35) {
            float h = fbm3(vObj*2.6 + vInst.x*9.0, 3, 2.4, 0.5);
            float hot = smoothstep(0.64, 0.82, h) * (vInst.y - 0.35) * 1.15;
            totalEmissiveRadiance += vec3(3.0, 0.78, 0.10) * hot;
          }
          totalEmissiveRadiance += vec3(1.0, 0.94, 0.86) * (vInst.z * 30.0);
        }
      `);
  };
  mat.customProgramCacheKey = () => 'tie-hull-v1';
  return mat;
}

/* =========================================================================
   SQUADRON
   ========================================================================= */

interface TIEi extends TIE {
  idx: number;
  vi: number;
  maxHp: number;
  speed: number;          // commanded speed
  baseSpeed: number;
  turnRate: number;
  aggression: number;
  seed: number;
  bank: number;
  rollPhase: number;
  fireTimer: number;
  fireCooldown: number;
  burst: number;
  muzzleIdx: number;
  modeTimer: number;
  thinkTimer: number;
  wander: number;
  axis: THREE.Vector3;
  flash: number;
  damageVis: number;
  sparkTimer: number;
  rendered: boolean;
  killed: boolean;
  pendingKill: boolean;
  deadTimer: number;
  engageDelay: number;
}

interface Panel {
  active: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  quat: THREE.Quaternion;
  spinAxis: THREE.Vector3;
  spinSpd: number;
  life: number;
  maxLife: number;
  scale: number;
  seed: number;
}

const MAX_PANELS = 24;
const PANEL_SIDES = [-1, 1] as const;
const BOOM_COL = new THREE.Color(1.0, 0.62, 0.24);

// ---- module-scope scratch (update() allocates nothing) ----
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _dir = new THREE.Vector3(), _fwd = new THREE.Vector3(), _rt = new THREE.Vector3();
const _up = new THREE.Vector3(), _up2 = new THREE.Vector3(), _rt2 = new THREE.Vector3();
const _lead = new THREE.Vector3(), _mz = new THREE.Vector3(), _perp = new THREE.Vector3();
const _sep = new THREE.Vector3(), _rad = new THREE.Vector3(), _tf = new THREE.Vector3();
const _cen = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _m1 = new THREE.Matrix4(), _m2 = new THREE.Matrix4();
const _sc1 = new THREE.Vector3(1, 1, 1);
const _WORLD_UP = new THREE.Vector3(0, 1, 0);
const _ALT_UP = new THREE.Vector3(0, 0, 1);
const _FWD_L = new THREE.Vector3(0, 0, -1);

/** Orientation whose local -Z is `dir`, rolled by `bank` around it. */
function orientTo(out: THREE.Quaternion, dir: THREE.Vector3, refUp: THREE.Vector3, bank: number) {
  _rt.crossVectors(dir, refUp);
  if (_rt.lengthSq() < 1e-6) _rt.crossVectors(dir, _ALT_UP);
  _rt.normalize();
  _up.crossVectors(_rt, dir).normalize();
  const cb = Math.cos(bank), sb = Math.sin(bank);
  _up2.copy(_up).multiplyScalar(cb).addScaledVector(_rt, sb).normalize();
  _rt2.crossVectors(dir, _up2).normalize();
  _v3.copy(dir).negate();
  _m1.makeBasis(_rt2, _up2, _v3);
  return out.setFromRotationMatrix(_m1);
}

/** A unit vector perpendicular to `d`, rotated by `a`. */
function perpOf(d: THREE.Vector3, a: number, out: THREE.Vector3) {
  out.set(0, 1, 0);
  if (Math.abs(d.y) > 0.92) out.set(1, 0, 0);
  _v1.crossVectors(d, out).normalize();
  _v2.crossVectors(d, _v1).normalize();
  return out.copy(_v1).multiplyScalar(Math.cos(a)).addScaledVector(_v2, Math.sin(a)).normalize();
}

class Squadron implements TIESquadron {
  group = new THREE.Group();
  ties: TIE[] = [];
  aliveCount = 0;
  kills = 0;

  private scene: THREE.Scene;
  private rng: RNG;
  private max: number;
  private builds: VariantBuild[];
  private hullMat: THREE.MeshStandardMaterial;
  private ionMat: THREE.ShaderMaterial;
  private meshes: THREE.InstancedMesh[] = [];
  private instAttrs: THREE.InstancedBufferAttribute[] = [];
  private ionMesh: THREE.InstancedMesh;
  private ionAttr: THREE.InstancedBufferAttribute;
  private debris: THREE.InstancedMesh;
  private debrisAttr: THREE.InstancedBufferAttribute;
  private panels: Panel[] = [];
  private minAlt: number | null = null;
  private list: TIEi[] = [];

  // virtual formation leader
  private anchorPos = new THREE.Vector3();
  private anchorQuat = new THREE.Quaternion();
  private anchorSpeed = 300;
  private time = 0;

  constructor(scene: THREE.Scene, opts: { seed?: number; max?: number } = {}) {
    this.scene = scene;
    this.max = Math.max(1, opts.max ?? 18);
    this.rng = new RNG(opts.seed ?? 90210);
    this.group.name = 'tie-squadron';

    this.hullMat = createTIEHullMaterial();
    this.ionMat = createIonMaterial();
    this.builds = VARIANTS.map((v, i) => buildVariant(v, (opts.seed ?? 90210) + i * 977));

    for (let i = 0; i < 3; i++) {
      const b = this.builds[i];
      const attr = new THREE.InstancedBufferAttribute(new Float32Array(this.max * 4), 4);
      attr.setUsage(THREE.DynamicDrawUsage);
      b.geo.setAttribute('aInst', attr);
      const m = new THREE.InstancedMesh(b.geo, this.hullMat, this.max);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.count = 0;
      m.name = `tie-${VARIANTS[i]}`;
      this.meshes.push(m);
      this.instAttrs.push(attr);
      this.group.add(m);
    }

    const ionGeo = buildIonGeometry();
    this.ionAttr = new THREE.InstancedBufferAttribute(new Float32Array(this.max * 2), 2);
    this.ionAttr.setUsage(THREE.DynamicDrawUsage);
    ionGeo.setAttribute('aIon', this.ionAttr);
    this.ionMesh = new THREE.InstancedMesh(ionGeo, this.ionMat, this.max);
    this.ionMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.ionMesh.frustumCulled = false;
    this.ionMesh.renderOrder = 3;
    this.ionMesh.count = 0;
    this.group.add(this.ionMesh);

    // detached wing panels
    const panelGeo = this.builds[0].wing.clone();
    this.debrisAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PANELS * 4), 4);
    this.debrisAttr.setUsage(THREE.DynamicDrawUsage);
    panelGeo.setAttribute('aInst', this.debrisAttr);
    this.debris = new THREE.InstancedMesh(panelGeo, this.hullMat, MAX_PANELS);
    this.debris.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.debris.frustumCulled = false;
    this.debris.count = 0;
    this.group.add(this.debris);
    for (let i = 0; i < MAX_PANELS; i++) {
      this.panels.push({
        active: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(),
        quat: new THREE.Quaternion(), spinAxis: new THREE.Vector3(0, 1, 0),
        spinSpd: 0, life: 0, maxLife: 1, scale: 1, seed: 0,
      });
    }

    // pool every TIE up front
    for (let i = 0; i < this.max; i++) this.list.push(this.makeTIE(i));
    this.ties = this.list;
    scene.add(this.group);
  }

  private makeTIE(i: number): TIEi {
    const root = new THREE.Object3D();
    root.matrixAutoUpdate = false;
    root.visible = false;
    this.group.add(root);
    const t: TIEi = {
      root,
      position: root.position,
      quaternion: root.quaternion,
      velocity: new THREE.Vector3(),
      mode: 'dead',
      hp: 0, alive: false,
      variant: 'fighter',
      slot: new THREE.Vector3(),
      radius: 3.6,
      idx: i, vi: 0, maxHp: 30,
      speed: 300, baseSpeed: 300, turnRate: 1.6,
      aggression: 1, seed: this.rng.next() * 97,
      bank: 0, rollPhase: 0,
      fireTimer: 0, fireCooldown: 0, burst: 0, muzzleIdx: 0,
      modeTimer: 0, thinkTimer: 0, wander: this.rng.next() * TAU,
      axis: new THREE.Vector3(0, 1, 0),
      flash: 0, damageVis: 0, sparkTimer: 0,
      rendered: false, killed: true, pendingKill: false, deadTimer: 0,
      engageDelay: 0,
    };
    return t;
  }

  /* ------------------------------------------------------------- spawning */

  spawn(pos: THREE.Vector3, forward: THREE.Vector3, count: number,
        opts: { mode?: TIEMode; variant?: TIE['variant']; spread?: number; speed?: number } = {}): TIE[] {
    const out: TIE[] = [];
    const mode = opts.mode ?? 'formation';
    const spread = opts.spread ?? 1;
    const speed = opts.speed ?? 320;
    _dir.copy(forward).normalize();
    orientTo(this.anchorQuat, _dir, _WORLD_UP, 0);
    this.anchorPos.copy(pos);
    this.anchorSpeed = speed;

    let hasAdvanced = this.list.some((t) => t.rendered && t.variant === 'advanced');
    let spawned = 0;
    for (const t of this.list) {
      if (spawned >= count) break;
      if (t.rendered) continue;

      let variant: TIE['variant'];
      if (opts.variant) variant = opts.variant;
      else if (!hasAdvanced && count >= 3 && spawned === 0) { variant = 'advanced'; hasAdvanced = true; }
      else variant = this.rng.bool(0.28) ? 'interceptor' : 'fighter';
      const vi = VARIANTS.indexOf(variant);
      const b = this.builds[vi];

      // wedge / echelon slot
      const n = spawned;
      const row = Math.ceil(n / 2);
      const side = n === 0 ? 0 : (n % 2 === 1 ? -1 : 1);
      const jitter = this.rng;
      t.slot.set(
        side * row * 22 * spread + jitter.gauss(0, 2.6),
        (row % 2 ? 5.5 : -4.0) * spread + jitter.gauss(0, 2.4),
        row * 17 * spread + jitter.gauss(0, 3.0),
      );

      t.variant = variant;
      t.vi = vi;
      t.radius = b.radius;
      t.maxHp = variant === 'advanced' ? 70 : variant === 'interceptor' ? 24 : 30;
      t.hp = t.maxHp;
      t.alive = true;
      t.killed = false;
      t.pendingKill = false;
      t.rendered = true;
      t.mode = mode;
      t.modeTimer = 0;
      t.thinkTimer = this.rng.range(0, 0.25);
      t.flash = 0;
      t.damageVis = 0;
      t.deadTimer = 0;
      t.burst = 0;
      t.fireCooldown = this.rng.range(0.2, 1.4);
      t.muzzleIdx = this.rng.int(0, 3);
      t.seed = this.rng.next() * 97;
      t.wander = this.rng.next() * TAU;
      t.aggression = this.rng.range(0.65, 1.45);
      t.engageDelay = this.rng.range(0.4, 3.4);
      t.baseSpeed = (variant === 'interceptor' ? 380 : variant === 'advanced' ? 340 : 320) * this.rng.range(0.92, 1.1);
      t.speed = speed;
      t.turnRate = (variant === 'interceptor' ? 1.95 : variant === 'advanced' ? 1.7 : 1.6) * this.rng.range(0.9, 1.1);
      t.bank = 0;
      t.rollPhase = this.rng.next() * TAU;
      t.axis.set(this.rng.gauss(), this.rng.gauss(), this.rng.gauss()).normalize();

      // place at the slot straight away
      _v1.copy(t.slot).applyQuaternion(this.anchorQuat).add(this.anchorPos);
      t.position.copy(_v1);
      t.quaternion.copy(this.anchorQuat);
      t.velocity.copy(_dir).multiplyScalar(speed);
      t.root.visible = true;
      t.root.matrix.compose(t.position, t.quaternion, _sc1);

      this.aliveCount++;
      spawned++;
      out.push(t);
    }
    return out;
  }

  /* ------------------------------------------------------------- damage / death */

  damage(t: TIE, amount: number): boolean {
    const ti = t as TIEi;
    if (!ti.alive || ti.pendingKill) return false;
    ti.hp -= amount;
    ti.damageVis = clamp(1 - ti.hp / Math.max(1, ti.maxHp), 0, 1);
    ti.flash = Math.max(ti.flash, 0.10);
    if (ti.hp <= 0) { ti.pendingKill = true; return true; }
    return false;
  }

  kill(t: TIE, fx: CombatFX) {
    const ti = t as TIEi;
    if (ti.killed) return;
    ti.killed = true;
    ti.pendingKill = false;
    ti.alive = false;
    ti.mode = 'dead';
    ti.hp = 0;
    ti.flash = 1;
    ti.deadTimer = 0.10;
    this.aliveCount = Math.max(0, this.aliveCount - 1);
    this.kills++;

    fx.explosion(ti.position, 14, { color: BOOM_COL, core: 44, life: 1.5, shock: true });
    fx.debrisBurst?.(ti.position, 14, {
      speed: 46, size: 1.4, spread: 1.0, life: 2.6, velocity: ti.velocity,
    });
    fx.sparks?.(ti.position, _v1.copy(ti.velocity).normalize(), 26, COL_TIE_ENGINE, 70);

    // two detached wing panels tumbling away
    for (const sx of PANEL_SIDES) {
      let p: Panel | null = null;
      for (let k = 0; k < this.panels.length; k++) { if (!this.panels[k].active) { p = this.panels[k]; break; } }
      if (!p) break;
      p.active = true;
      _v1.set(sx * 4.05, 0, 0).applyQuaternion(ti.quaternion);
      p.pos.copy(ti.position).add(_v1);
      p.vel.copy(ti.velocity).multiplyScalar(0.55);
      p.vel.x += this.rng.gauss(0, 16) + sx * 12;
      p.vel.y += this.rng.gauss(0, 16);
      p.vel.z += this.rng.gauss(0, 16);
      p.quat.copy(ti.quaternion);
      p.spinAxis.set(this.rng.gauss(), this.rng.gauss(), this.rng.gauss()).normalize();
      p.spinSpd = this.rng.range(2.2, 6.5) * this.rng.sign();
      p.maxLife = this.rng.range(2.2, 3.4);
      p.life = p.maxLife;
      p.scale = 1;
      p.seed = this.rng.next() * 97;
    }
  }

  breakOff() {
    for (const t of this.list) {
      if (!t.rendered || !t.alive) continue;
      t.mode = 'flee';
      t.modeTimer = 0;
      t.burst = 0;
      t.axis.set(this.rng.gauss(), this.rng.gauss(0.4, 0.6), this.rng.gauss()).normalize();
    }
  }

  setBounds(minAltitude: number | null) { this.minAlt = minAltitude; }

  clear() {
    for (const t of this.list) {
      t.rendered = false; t.alive = false; t.killed = true; t.pendingKill = false;
      t.mode = 'dead'; t.flash = 0; t.damageVis = 0; t.root.visible = false;
    }
    for (const p of this.panels) p.active = false;
    this.aliveCount = 0;
    for (const m of this.meshes) m.count = 0;
    this.ionMesh.count = 0;
    this.debris.count = 0;
  }

  dispose() {
    this.group.removeFromParent();
    for (const b of this.builds) { b.geo.dispose(); b.wing.dispose(); }
    this.ionMesh.geometry.dispose();
    this.debris.geometry.dispose();
    for (const m of this.meshes) m.dispose();
    this.ionMesh.dispose();
    this.debris.dispose();
    this.hullMat.dispose();
    this.ionMat.dispose();
  }

  /* ------------------------------------------------------------- hit test */

  hitTest(from: THREE.Vector3, to: THREE.Vector3) {
    _v1.subVectors(to, from);
    const segLen = _v1.length();
    if (segLen < 1e-4) return null;
    _v1.multiplyScalar(1 / segLen);
    let best = -1, bestT = Infinity;
    for (let i = 0; i < this.list.length; i++) {
      const t = this.list[i];
      if (!t.alive || !t.rendered) continue;
      _v2.subVectors(t.position, from);
      const proj = _v2.dot(_v1);
      if (proj < -t.radius || proj > segLen + t.radius) continue;
      const d2 = _v2.lengthSq() - proj * proj;
      const r2 = t.radius * t.radius;
      if (d2 > r2) continue;
      const back = Math.sqrt(Math.max(0, r2 - d2));
      const hitT = proj - back;
      if (hitT < bestT) { bestT = hitT; best = i; }
    }
    if (best < 0) return null;
    const tie = this.list[best];
    const point = new THREE.Vector3().copy(from).addScaledVector(_v1, Math.max(0, bestT));
    const normal = new THREE.Vector3().subVectors(point, tie.position).normalize();
    return { tie: tie as TIE, point, normal };
  }

  /* ------------------------------------------------------------- update */

  update(dt: number, time: number, target: TargetInfo, fx: CombatFX) {
    if (dt <= 0) dt = 1e-4;
    this.time = time;
    ((this.hullMat as any).userData.uniforms as HullUniforms).uTime.value = time;
    this.ionMat.uniforms.uTime.value = time;

    // ---- virtual formation leader drifts forward with a lazy weave ----
    _fwd.set(0, 0, -1).applyQuaternion(this.anchorQuat);
    this.anchorPos.addScaledVector(_fwd, this.anchorSpeed * dt);
    _rt.set(1, 0, 0).applyQuaternion(this.anchorQuat);
    this.anchorPos.addScaledVector(_rt, Math.sin(time * 0.23) * 26 * dt);
    _up.set(0, 1, 0).applyQuaternion(this.anchorQuat);
    this.anchorPos.addScaledVector(_up, Math.sin(time * 0.17 + 1.2) * 16 * dt);

    _tf.set(0, 0, -1).applyQuaternion(target.quaternion);

    // squadron centroid (engaged ships only) — used for loose cohesion
    _cen.set(0, 0, 0);
    let cn = 0;
    for (const t of this.list) {
      if (!t.rendered || !t.alive) continue;
      if (t.mode === 'pursue' || t.mode === 'attack' || t.mode === 'strafe') { _cen.add(t.position); cn++; }
    }
    if (cn > 0) _cen.multiplyScalar(1 / cn);

    for (let i = 0; i < this.list.length; i++) {
      const t = this.list[i];
      if (!t.rendered) continue;

      if (t.pendingKill) this.kill(t, fx);

      if (!t.alive) {
        // brief white-hot flash frame, then vanish
        t.position.addScaledVector(t.velocity, dt);
        t.flash = Math.max(0, t.flash - dt * 9);
        t.deadTimer -= dt;
        if (t.deadTimer <= 0) { t.rendered = false; t.root.visible = false; }
        t.root.matrix.compose(t.position, t.quaternion, _sc1);
        continue;
      }

      t.flash = Math.max(0, t.flash - dt * 6);
      t.modeTimer += dt;
      t.thinkTimer -= dt;

      const dist = t.position.distanceTo(target.position);
      // lead-predicted intercept
      const lt = clamp(dist / 950, 0, 1.35);
      _lead.copy(target.velocity).multiplyScalar(lt).add(target.position);

      _fwd.set(0, 0, -1).applyQuaternion(t.quaternion);
      _v1.subVectors(_lead, t.position);
      const leadDist = Math.max(1e-3, _v1.length());
      _v1.multiplyScalar(1 / leadDist);
      const aimErr = Math.acos(clamp(_fwd.dot(_v1), -1, 1));

      // is the player sitting on this TIE's tail?
      _v2.subVectors(t.position, target.position).normalize();
      const chased = _v2.dot(_tf) > 0.86 && dist < 620;

      if (t.thinkTimer <= 0) {
        t.thinkTimer = 0.22 + (t.seed % 1) * 0.16;
        this.think(t, dist, aimErr, chased);
      }

      /* ---------------- desired direction per mode ---------------- */
      _dir.copy(_v1);
      let wantSpeed = t.baseSpeed;
      let bankGain = 2.1;

      switch (t.mode) {
        case 'formation': {
          _v2.copy(t.slot);
          _v2.x += Math.sin(time * 0.71 + t.wander) * 4.5;
          _v2.y += Math.sin(time * 0.53 + t.wander * 2.1) * 3.2;
          _v2.z += Math.sin(time * 0.61 + t.wander * 3.3) * 5.0;
          _v2.applyQuaternion(this.anchorQuat).add(this.anchorPos);
          _v3.subVectors(_v2, t.position);
          const err = _v3.length();
          _fwd.set(0, 0, -1).applyQuaternion(this.anchorQuat);
          _dir.copy(_v3).addScaledVector(_fwd, 90 + err * 0.35).normalize();
          wantSpeed = this.anchorSpeed + clamp(_v3.dot(_fwd) * 0.75, -110, 150);
          bankGain = 1.5;
          break;
        }
        case 'pursue': {
          // stand off: aim past the target when very close so they don't ram
          if (dist < 240) {
            perpOf(_v1, t.seed * 1.7 + time * 0.4, _perp);
            _dir.copy(_v1).addScaledVector(_perp, 0.85).normalize();
          }
          wantSpeed = t.baseSpeed * 1.12;
          break;
        }
        case 'attack': {
          // small weave so the burst doesn't come from a rigid line
          perpOf(_v1, t.seed * 2.3 + time * 1.6, _perp);
          _dir.copy(_v1).addScaledVector(_perp, 0.055).normalize();
          wantSpeed = t.baseSpeed * (dist > 900 ? 1.15 : 0.94);
          bankGain = 2.5;
          break;
        }
        case 'strafe': {
          // cross the target's course at speed: pick a heading square to its flight path
          _v3.crossVectors(_tf, t.axis);
          if (_v3.lengthSq() < 1e-4) _v3.crossVectors(_tf, _ALT_UP);
          _v3.normalize();
          _v2.copy(target.velocity).multiplyScalar(0.6).add(target.position).addScaledVector(_v3, 340);
          _dir.subVectors(_v2, t.position).normalize();
          wantSpeed = t.baseSpeed * 1.3;
          bankGain = 2.8;
          break;
        }
        case 'evade': {
          _v2.subVectors(t.position, target.position).normalize();
          t.rollPhase += dt * 7.5;
          perpOf(_v2, t.rollPhase, _perp);
          _dir.copy(_v2).addScaledVector(_perp, 0.62).normalize();
          wantSpeed = t.baseSpeed * 1.22;
          bankGain = 0.0;   // the barrel roll owns the roll axis
          break;
        }
        case 'flee': {
          _v2.subVectors(t.position, target.position).normalize();
          _dir.copy(_v2).addScaledVector(t.axis, 0.55).normalize();
          wantSpeed = t.baseSpeed * 1.45;
          break;
        }
        default: break;
      }

      /* ---------------- loose cohesion: stay a squadron ---------------- */
      if (cn > 1 && (t.mode === 'pursue' || t.mode === 'attack' || t.mode === 'strafe')) {
        _v2.subVectors(_cen, t.position);
        const cd = _v2.length();
        if (cd > 190) _dir.addScaledVector(_v2.multiplyScalar(1 / cd), clamp((cd - 190) / 420, 0, 0.45)).normalize();
      }

      /* ---------------- separation from squadron mates ---------------- */
      _sep.set(0, 0, 0);
      for (let j = 0; j < this.list.length; j++) {
        if (j === i) continue;
        const o = this.list[j];
        if (!o.rendered || !o.alive) continue;
        _v2.subVectors(t.position, o.position);
        const d2 = _v2.lengthSq();
        if (d2 > 3600 || d2 < 1e-4) continue;
        _sep.addScaledVector(_v2, (1 / Math.sqrt(d2)) * (1 - Math.sqrt(d2) / 60));
      }
      if (_sep.lengthSq() > 1e-6) _dir.addScaledVector(_sep.normalize(), 0.55).normalize();

      /* ---------------- altitude bound ---------------- */
      let refUp = _WORLD_UP;
      if (this.minAlt !== null) {
        const alt = t.position.length();
        _rad.copy(t.position).normalize();
        refUp = _rad;
        const push = smoothstep(this.minAlt + 260, this.minAlt - 40, alt);
        if (push > 0) {
          _dir.addScaledVector(_rad, push * 2.4).normalize();
          if (alt < this.minAlt) {
            t.position.setLength(this.minAlt);
            if (t.velocity.dot(_rad) < 0) t.velocity.addScaledVector(_rad, -t.velocity.dot(_rad) * 1.6);
          }
        }
      }

      /* ---------------- orientation: bank into the turn ---------------- */
      _fwd.set(0, 0, -1).applyQuaternion(t.quaternion);
      _rt.set(1, 0, 0).applyQuaternion(t.quaternion);
      const lat = _dir.dot(_rt);
      const bankTarget = clamp(lat * bankGain, -1.2, 1.2);
      t.bank = damp(t.bank, bankTarget, 4.2, dt);
      let roll = t.bank;
      if (t.mode === 'evade') roll = t.rollPhase;
      // slight pitch-into-velocity: nose follows where it is actually going
      _v2.copy(t.velocity);
      if (_v2.lengthSq() > 1) { _v2.normalize(); _dir.addScaledVector(_v2, 0.14).normalize(); }

      orientTo(_q1, _dir, refUp, roll);
      _q2.copy(t.quaternion);
      dampQ(t.quaternion, _q1, 4.4, dt);
      const turned = _q2.angleTo(t.quaternion);
      const maxTurn = t.turnRate * dt;
      if (turned > maxTurn) t.quaternion.copy(_q2).rotateTowards(_q1, maxTurn);

      /* ---------------- integrate ---------------- */
      t.speed = damp(t.speed, clamp(wantSpeed, 200, 430), 2.0, dt);
      _fwd.set(0, 0, -1).applyQuaternion(t.quaternion);
      _v2.copy(_fwd).multiplyScalar(t.speed);
      dampV(t.velocity, _v2, 3.4, dt);
      t.position.addScaledVector(t.velocity, dt);
      t.root.matrix.compose(t.position, t.quaternion, _sc1);

      /* ---------------- guns ---------------- */
      t.fireCooldown -= dt;
      if (t.mode === 'attack' && dist < 1100 && dist > 90) {
        if (t.burst > 0) {
          t.fireTimer -= dt;
          if (t.fireTimer <= 0) { this.shoot(t, _lead, fx); t.burst--; t.fireTimer = 0.12; }
        } else if (t.fireCooldown <= 0 && aimErr < 4 * DEG) {
          t.burst = 2 + Math.floor(this.rng.next() * 3);
          t.fireTimer = 0;
          t.fireCooldown = this.rng.range(0.75, 2.1) / t.aggression;
        }
      } else {
        t.burst = 0;
      }

      /* ---------------- damage smoke / embers ---------------- */
      t.damageVis = damp(t.damageVis, clamp(1 - t.hp / t.maxHp, 0, 1), 6, dt);
      if (t.damageVis > 0.6 && fx.sparks) {
        t.sparkTimer -= dt;
        if (t.sparkTimer <= 0) {
          t.sparkTimer = 0.07 + this.rng.next() * 0.06;
          _v2.copy(t.velocity).normalize().negate();
          _v3.copy(t.position).addScaledVector(_v2, 1.2);
          fx.sparks(_v3, _v2, 2, EMBER_COL, 22);
        }
      }
    }

    this.updatePanels(dt);
    this.writeInstances();
  }

  /* ------------------------------------------------------------- state machine */

  private think(t: TIEi, dist: number, aimErr: number, chased: boolean) {
    const set = (m: TIEMode) => { if (t.mode !== m) { t.mode = m; t.modeTimer = 0; t.burst = 0; } };
    switch (t.mode) {
      case 'formation':
        t.engageDelay -= 0.22;
        if (dist < 2400 && t.engageDelay <= 0) set('pursue');
        break;
      case 'pursue':
        if (chased && this.rng.bool(0.5)) { this.pickAxis(t); set('evade'); }
        else if (dist < 1000 && aimErr < 26 * DEG) set('attack');
        else if (dist > 3200 && t.modeTimer > 5) set('pursue');
        break;
      case 'attack':
        if (dist < 130 || t.modeTimer > 5.0 + t.aggression * 2) {
          this.pickAxis(t);
          set(this.rng.bool(0.55) ? 'strafe' : 'evade');
        } else if (dist > 1500) set('pursue');
        else if (chased && this.rng.bool(0.35)) { this.pickAxis(t); set('evade'); }
        break;
      case 'strafe':
        if (t.modeTimer > 2.6 + this.rng.next() * 1.6) set('pursue');
        break;
      case 'evade':
        if (t.modeTimer > 2.2 + this.rng.next() * 1.8 && !chased) set('pursue');
        else if (t.modeTimer > 5) set('pursue');
        break;
      default: break;
    }
  }

  private pickAxis(t: TIEi) {
    _v1.set(this.rng.gauss(), this.rng.gauss(), this.rng.gauss());
    if (_v1.lengthSq() < 1e-4) _v1.set(0, 1, 0);
    t.axis.copy(_v1).normalize();
  }

  /* ------------------------------------------------------------- guns */

  private shoot(t: TIEi, aimPoint: THREE.Vector3, fx: CombatFX) {
    const mz = this.builds[t.vi].muzzles;
    const m = mz[t.muzzleIdx % mz.length];
    t.muzzleIdx++;
    _mz.copy(m).applyQuaternion(t.quaternion).add(t.position);
    _v1.subVectors(aimPoint, _mz).normalize();
    // deliberately imperfect: 0.5deg - 2.5deg of angular error per shot
    const err = (0.5 + this.rng.next() * 2.0) * DEG;
    perpOf(_v1, this.rng.next() * TAU, _perp);
    _v1.addScaledVector(_perp, Math.tan(err)).normalize();
    fx.laser(_mz, _v1, {
      color: COL_IMP_LASER, speed: 1150, length: 26, radius: 0.24,
      life: 2.0, hostile: true, owner: 'tie', damage: 8,
    });
    fx.muzzleFlash?.(_mz, _v1, COL_IMP_LASER, 0.8);
  }

  /* ------------------------------------------------------------- debris panels */

  private updatePanels(dt: number) {
    let n = 0;
    for (const p of this.panels) {
      if (!p.active) continue;
      p.life -= dt;
      if (p.life <= 0) { p.active = false; continue; }
      p.pos.addScaledVector(p.vel, dt);
      p.vel.multiplyScalar(1 - Math.min(0.9, 0.22 * dt));
      _q1.setFromAxisAngle(p.spinAxis, p.spinSpd * dt);
      p.quat.premultiply(_q1);
      const k = p.life / p.maxLife;
      const fade = k > 0.7 ? 1 : k / 0.7;
      _v1.setScalar(0.55 + 0.45 * fade);
      _m2.compose(p.pos, p.quat, _v1);
      this.debris.setMatrixAt(n, _m2);
      this.debrisAttr.setXYZW(n, p.seed, 0.58, 0, fade);
      n++;
    }
    this.debris.count = n;
    if (n > 0) { this.debris.instanceMatrix.needsUpdate = true; this.debrisAttr.needsUpdate = true; }
  }

  /* ------------------------------------------------------------- instancing */

  private writeInstances() {
    let c0 = 0, c1 = 0, c2 = 0, ci = 0;
    for (const t of this.list) {
      if (!t.rendered) continue;
      const mesh = this.meshes[t.vi];
      const attr = this.instAttrs[t.vi];
      const slot = t.vi === 0 ? c0++ : t.vi === 1 ? c1++ : c2++;
      mesh.setMatrixAt(slot, t.root.matrix);
      attr.setXYZW(slot, t.seed, t.damageVis, t.flash, 1);

      _m2.multiplyMatrices(t.root.matrix, this.builds[t.vi].ionOffset);
      this.ionMesh.setMatrixAt(ci, _m2);
      this.ionAttr.setXY(ci, t.seed * 1.7, t.alive ? clamp(0.72 + (t.speed - 260) / 420, 0.66, 1.30) : 0);
      ci++;
    }
    const counts = [c0, c1, c2];
    for (let v = 0; v < 3; v++) {
      this.meshes[v].count = counts[v];
      if (counts[v] > 0) {
        this.meshes[v].instanceMatrix.needsUpdate = true;
        this.instAttrs[v].needsUpdate = true;
      }
    }
    this.ionMesh.count = ci;
    if (ci > 0) { this.ionMesh.instanceMatrix.needsUpdate = true; this.ionAttr.needsUpdate = true; }
  }
}

const EMBER_COL = new THREE.Color(1.0, 0.55, 0.16);

export function createTIESquadron(scene: THREE.Scene, opts?: { seed?: number; max?: number }): TIESquadron {
  return new Squadron(scene, opts);
}
