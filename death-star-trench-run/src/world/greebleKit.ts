import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RNG } from '../core/rng';

/* =========================================================================
   GREEBLE KIT
   A library of small procedural mechanical parts. Every builder returns a
   BufferGeometry in a canonical frame:
       origin at the *base centre*, +Y up (away from the surface),
       footprint roughly centred on X/Z.
   Geometries carry position + normal + uv, and an extra `aEmis` float
   attribute (0..1) marking lit windows / glowing vents so one shared
   material can render both plating and emissive detail.
   ========================================================================= */

const UP = new THREE.Vector3(0, 1, 0);

function tag(g: THREE.BufferGeometry, emis: number, mat = 0): THREE.BufferGeometry {
  const n = g.attributes.position.count;
  const e = new Float32Array(n);
  const m = new Float32Array(n);
  e.fill(emis); m.fill(mat);
  g.setAttribute('aEmis', new THREE.BufferAttribute(e, 1));
  g.setAttribute('aMat', new THREE.BufferAttribute(m, 1));
  if (!g.attributes.uv) {
    const uv = new Float32Array(n * 2);
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  }
  return g;
}

function place(g: THREE.BufferGeometry, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  if (rx || ry || rz) {
    const e = new THREE.Euler(rx, ry, rz);
    g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(e));
  }
  g.translate(x, y, z);
  return g;
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const cleaned = parts.filter(Boolean);
  for (const p of cleaned) { if (p.index) p.toNonIndexed?.(); }
  const m = mergeGeometries(cleaned.map((p) => (p.index ? p.toNonIndexed() : p)), false);
  if (!m) throw new Error('greebleKit: merge failed');
  m.computeVertexNormals();
  return m;
}

/* ---------------------------------------------------------------- primitives */

export function box(w: number, h: number, d: number, emis = 0, mat = 0) {
  return tag(new THREE.BoxGeometry(w, h, d).translate(0, h / 2, 0), emis, mat);
}

/** Chamfered slab — reads far better than a raw box under raking light. */
export function slab(w: number, h: number, d: number, chamfer = 0.12, emis = 0, mat = 0) {
  const c = Math.min(chamfer, Math.min(w, d) * 0.35, h * 0.45);
  const shape = new THREE.Shape();
  const hw = w / 2, hd = d / 2;
  shape.moveTo(-hw + c, -hd);
  shape.lineTo(hw - c, -hd); shape.lineTo(hw, -hd + c);
  shape.lineTo(hw, hd - c); shape.lineTo(hw - c, hd);
  shape.lineTo(-hw + c, hd); shape.lineTo(-hw, hd - c);
  shape.lineTo(-hw, -hd + c); shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: true, bevelThickness: c * 0.5, bevelSize: c * 0.5, bevelSegments: 1, curveSegments: 1 });
  g.rotateX(-Math.PI / 2);
  g.translate(0, h, 0);
  return tag(g, emis, mat);
}

export function cyl(r: number, h: number, seg = 10, emis = 0, mat = 0) {
  return tag(new THREE.CylinderGeometry(r, r, h, seg, 1, false).translate(0, h / 2, 0), emis, mat);
}

export function taperedCyl(r0: number, r1: number, h: number, seg = 8, emis = 0, mat = 0) {
  return tag(new THREE.CylinderGeometry(r1, r0, h, seg, 1, false).translate(0, h / 2, 0), emis, mat);
}

/* ---------------------------------------------------------------- assemblies */

/** Blocky sensor / comms tower. */
export function tower(rng: RNG, scale = 1): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  let w = rng.range(3, 7) * scale;
  let d = w * rng.range(0.7, 1.3);
  let y = 0;
  const tiers = rng.int(2, 4);
  for (let i = 0; i < tiers; i++) {
    const h = rng.range(3, 9) * scale;
    parts.push(place(slab(w, h, d, 0.25 * scale, 0, 0), 0, y, 0));
    // side boxes
    if (rng.bool(0.55)) {
      const sw = w * rng.range(0.2, 0.4);
      parts.push(place(box(sw, h * rng.range(0.3, 0.7), d * 0.6, rng.bool(0.25) ? 1 : 0, 1),
        (w / 2 + sw / 2) * rng.sign(), y + h * 0.15, 0));
    }
    y += h;
    w *= rng.range(0.55, 0.82); d *= rng.range(0.55, 0.82);
  }
  // mast
  if (rng.bool(0.7)) {
    const mh = rng.range(4, 14) * scale;
    parts.push(place(cyl(rng.range(0.25, 0.6) * scale, mh, 6, 0, 2), 0, y, 0));
    parts.push(place(cyl(rng.range(0.5, 1.1) * scale, 0.5 * scale, 8, 1, 3), 0, y + mh, 0));
  }
  // lit band
  if (rng.bool(0.6)) parts.push(place(box(w * 1.15, 0.35 * scale, d * 0.25, 1, 3), 0, y * rng.range(0.3, 0.7), d * 0.42));
  return merge(parts);
}

/** Recessed grille / heat exchanger. */
export function vent(rng: RNG, scale = 1): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const w = rng.range(5, 12) * scale, d = rng.range(4, 9) * scale;
  parts.push(place(slab(w, 0.9 * scale, d, 0.3 * scale, 0, 0), 0, 0, 0));
  const n = rng.int(4, 9);
  const emis = rng.bool(0.4) ? 1 : 0;
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    parts.push(place(box(w * 0.86, rng.range(0.5, 1.3) * scale, (d / n) * 0.55, emis, emis ? 3 : 1),
      0, 0.55 * scale, (t - 0.5) * d * 0.9));
  }
  parts.push(place(box(w * 1.02, 1.5 * scale, 0.5 * scale, 0, 0), 0, 0, d / 2));
  parts.push(place(box(w * 1.02, 1.5 * scale, 0.5 * scale, 0, 0), 0, 0, -d / 2));
  return merge(parts);
}

/** Pipe run with elbows and support collars. */
export function pipeRun(rng: RNG, length: number, scale = 1): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const r = rng.range(0.4, 1.4) * scale;
  const h = rng.range(1.5, 4) * scale;
  const g = cyl(r, length, 8, 0, 2);
  g.rotateX(Math.PI / 2);
  parts.push(place(g, 0, h, 0));
  const n = Math.max(2, Math.floor(length / rng.range(8, 20)));
  for (let i = 0; i <= n; i++) {
    const z = (i / n - 0.5) * length;
    parts.push(place(box(r * 2.6, h, r * 1.4, 0, 0), 0, 0, z));
    if (rng.bool(0.3)) parts.push(place(cyl(r * 1.5, r * 0.8, 8, 0, 1), 0, h - r * 0.4, z));
  }
  if (rng.bool(0.5)) {
    const r2 = r * rng.range(0.5, 0.85);
    const g2 = cyl(r2, length, 6, 0, 2); g2.rotateX(Math.PI / 2);
    parts.push(place(g2, r * 2.4, h * rng.range(0.6, 1.1), 0));
  }
  return merge(parts);
}

/** Antenna / dish cluster. */
export function antenna(rng: RNG, scale = 1): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(place(slab(rng.range(2, 4) * scale, 1 * scale, rng.range(2, 4) * scale, 0.2, 0, 0), 0, 0, 0));
  const mh = rng.range(6, 18) * scale;
  parts.push(place(taperedCyl(0.55 * scale, 0.2 * scale, mh, 6, 0, 2), 0, 0.9 * scale, 0));
  const type = rng.int(0, 2);
  if (type === 0) {
    const d = new THREE.SphereGeometry(rng.range(1.5, 4) * scale, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.42);
    d.rotateX(Math.PI * rng.range(0.75, 1.15));
    parts.push(place(tag(d, 0, 1), 0, mh * rng.range(0.75, 1.0), 0));
  } else if (type === 1) {
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      const arm = cyl(0.16 * scale, rng.range(3, 7) * scale, 5, 0, 2);
      arm.rotateZ(Math.PI * 0.28);
      parts.push(place(arm, Math.cos(a) * 0.5 * scale, mh * 0.9, Math.sin(a) * 0.5 * scale, 0, a, 0));
    }
  } else {
    parts.push(place(box(rng.range(1, 2.5) * scale, rng.range(1.5, 3) * scale, 0.35 * scale, 1, 3), 0, mh * 0.85, 0));
  }
  if (rng.bool(0.5)) parts.push(place(cyl(0.35 * scale, 0.35 * scale, 6, 1, 3), 0, mh + 0.4 * scale, 0));
  return merge(parts);
}

/** Big surface machinery block — the workhorse silhouette breaker. */
export function machinery(rng: RNG, scale = 1): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const w = rng.range(8, 20) * scale, d = rng.range(6, 16) * scale, h = rng.range(3, 9) * scale;
  parts.push(place(slab(w, h, d, 0.5 * scale, 0, 0), 0, 0, 0));
  const n = rng.int(3, 8);
  for (let i = 0; i < n; i++) {
    const k = rng.next();
    const px = rng.range(-0.42, 0.42) * w, pz = rng.range(-0.42, 0.42) * d;
    if (k < 0.3) {
      parts.push(place(box(rng.range(0.1, 0.28) * w, rng.range(0.3, 1.2) * h, rng.range(0.1, 0.3) * d, 0, 1), px, h, pz));
    } else if (k < 0.55) {
      parts.push(place(cyl(rng.range(0.4, 1.4) * scale, rng.range(1, 4) * scale, 8, 0, 2), px, h, pz));
    } else if (k < 0.75) {
      parts.push(place(box(rng.range(0.15, 0.4) * w, 0.25 * scale, rng.range(0.15, 0.4) * d, 1, 3), px, h + 0.02, pz));
    } else {
      const pr = pipeRun(rng, rng.range(0.4, 0.9) * d, scale * 0.7);
      parts.push(place(pr, px, h, pz, 0, rng.bool() ? Math.PI / 2 : 0, 0));
    }
  }
  // skirt / lit underside strip
  parts.push(place(box(w * 1.06, 0.3 * scale, d * 1.06, rng.bool(0.5) ? 1 : 0, 3), 0, h * 0.12, 0));
  return merge(parts);
}

/** Recessed hatch / docking bay (sits flush, extends *down*). */
export function recess(rng: RNG, scale = 1): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const w = rng.range(8, 22) * scale, d = rng.range(6, 18) * scale, dep = rng.range(2, 6) * scale;
  const inner = box(w * 0.86, 0.3 * scale, d * 0.86, rng.bool(0.5) ? 0.8 : 0.1, 3);
  parts.push(place(inner, 0, -dep, 0));
  const rim = 0.09;
  parts.push(place(box(w * rim, dep, d, 0, 0), -w * (0.5 - rim / 2), -dep, 0));
  parts.push(place(box(w * rim, dep, d, 0, 0), w * (0.5 - rim / 2), -dep, 0));
  parts.push(place(box(w, dep, d * rim, 0, 0), 0, -dep, -d * (0.5 - rim / 2)));
  parts.push(place(box(w, dep, d * rim, 0, 0), 0, -dep, d * (0.5 - rim / 2)));
  return merge(parts);
}

/** Flat panel plate with a raised lip — cheap coverage filler. */
export function plate(rng: RNG, scale = 1): THREE.BufferGeometry {
  const w = rng.range(10, 28) * scale, d = rng.range(8, 22) * scale;
  const h = rng.range(0.4, 1.6) * scale;
  const parts = [slab(w, h, d, 0.4 * scale, 0, 0)];
  if (rng.bool(0.45)) parts.push(place(box(w * rng.range(0.5, 0.9), h * 0.4, 0.35 * scale, 1, 3), 0, h, d * rng.range(-0.4, 0.4)));
  if (rng.bool(0.35)) parts.push(place(slab(w * rng.range(0.3, 0.6), h * rng.range(0.8, 2.2), d * rng.range(0.3, 0.6), 0.25 * scale, 0, 1), rng.range(-0.2, 0.2) * w, h, rng.range(-0.2, 0.2) * d));
  return merge(parts);
}

/** Trench-style bridge / span that crosses a gap. Length along +Z. */
export function bridge(rng: RNG, span: number, scale = 1): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const w = rng.range(4, 10) * scale;
  const th = rng.range(1.2, 3) * scale;
  const deck = box(w, th, span, 0, 0); place(deck, 0, 0, 0);
  parts.push(deck);
  const n = Math.max(2, Math.floor(span / rng.range(9, 18)));
  for (let i = 0; i <= n; i++) {
    const z = (i / n - 0.5) * span * 0.94;
    parts.push(place(box(w * 1.18, th * rng.range(1.4, 2.4), th * 0.7, 0, 1), 0, -th * 0.2, z));
  }
  // handrail-ish lit strip
  parts.push(place(box(0.35 * scale, 0.35 * scale, span, 1, 3), w / 2, th, 0));
  parts.push(place(box(0.35 * scale, 0.35 * scale, span, 1, 3), -w / 2, th, 0));
  // under-truss
  for (let i = 0; i < n; i++) {
    const z = ((i + 0.5) / n - 0.5) * span * 0.94;
    const t = cyl(0.3 * scale, th * 3.2, 5, 0, 2); t.rotateX(Math.PI * 0.5 * (i % 2 ? 0.45 : -0.45));
    parts.push(place(t, 0, -th * 1.6, z));
  }
  return merge(parts);
}

/** Turbolaser emplacement: base + yoke; barrels are separate so they can aim. */
export function turretBase(rng: RNG, scale = 1): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(place(taperedCyl(3.2 * scale, 2.4 * scale, 1.6 * scale, 10, 0, 0), 0, 0, 0));
  parts.push(place(cyl(2.9 * scale, 0.35 * scale, 10, 1, 3), 0, 1.6 * scale, 0));
  return merge(parts);
}
export function turretHead(rng: RNG, scale = 1): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(place(slab(4.4 * scale, 2.4 * scale, 3.4 * scale, 0.5 * scale, 0, 0), 0, 0, 0));
  parts.push(place(box(1.2 * scale, 1.6 * scale, 2.2 * scale, 0, 1), -2.2 * scale, 0.4 * scale, 0));
  parts.push(place(box(1.2 * scale, 1.6 * scale, 2.2 * scale, 0, 1), 2.2 * scale, 0.4 * scale, 0));
  return merge(parts);
}
export function turretBarrels(rng: RNG, scale = 1): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const len = rng.range(7, 11) * scale;
  for (const sx of [-1, 1]) {
    const b = taperedCyl(0.62 * scale, 0.4 * scale, len, 8, 0, 2);
    b.rotateX(-Math.PI / 2);
    parts.push(place(b, sx * 1.1 * scale, 0, 0));
    const c = cyl(0.85 * scale, 1.2 * scale, 8, 0, 1); c.rotateX(-Math.PI / 2);
    parts.push(place(c, sx * 1.1 * scale, 0, len * 0.28));
    const tip = cyl(0.5 * scale, 0.5 * scale, 8, 1, 3); tip.rotateX(-Math.PI / 2);
    parts.push(place(tip, sx * 1.1 * scale, 0, -len * 0.98));
  }
  parts.push(place(slab(3.4 * scale, 1.6 * scale, 2.6 * scale, 0.35 * scale, 0, 0), 0, -0.8 * scale, 1.2 * scale));
  return merge(parts);
}

/**
 * Build a palette of distinct greeble geometries for InstancedMesh use.
 * `kinds` picks which builders participate.
 */
export type GreebleKind = 'tower' | 'vent' | 'pipe' | 'antenna' | 'machinery' | 'recess' | 'plate';
export function greebleAtlas(seed: number, count: number, kinds: GreebleKind[], scale = 1): THREE.BufferGeometry[] {
  const rng = new RNG(seed);
  const out: THREE.BufferGeometry[] = [];
  for (let i = 0; i < count; i++) {
    const k = kinds[i % kinds.length];
    switch (k) {
      case 'tower': out.push(tower(rng, scale)); break;
      case 'vent': out.push(vent(rng, scale)); break;
      case 'pipe': out.push(pipeRun(rng, rng.range(14, 40) * scale, scale)); break;
      case 'antenna': out.push(antenna(rng, scale)); break;
      case 'machinery': out.push(machinery(rng, scale)); break;
      case 'recess': out.push(recess(rng, scale)); break;
      case 'plate': out.push(plate(rng, scale)); break;
    }
  }
  return out;
}

/** Approximate bounding radius, useful for culling. */
export function radiusOf(g: THREE.BufferGeometry) {
  g.computeBoundingSphere();
  return g.boundingSphere?.radius ?? 1;
}
