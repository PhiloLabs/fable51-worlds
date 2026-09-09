import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RNG } from '../core/rng';
import { GLSL_HASH, GLSL_NOISE, GLSL_COLOR } from '../shaders/lib';

/* =========================================================================
   X-WING PARTS — geometry kit, shared materials, engine-plume shaders.

   Canonical ship frame (also the frame every geometry helper works in):
     -Z = nose,  +Y = up,  +X = starboard,  origin ~ centre of mass.

   ATTRIBUTE CONTRACT
   Every geometry that goes into a merged hull mesh carries exactly
     position, normal, uv, aWing, aSlide, aEmis
   so `mergeGeometries` can fold the whole ship into three draw calls.
     aWing  0        = rigid fuselage
            1..4     = s-foil wing index (rotated in the vertex shader about a
                       Z-parallel axis through that wing's hinge)
     aSlide -1/0/+1  = actuator piston; displaced along local X by uWingExt
     aEmis  0..1     = emissive trim mask (nav lights, R2 lens, instruments)
   ========================================================================= */

export const WING_ATTRS = ['position', 'normal', 'uv', 'aWing', 'aSlide', 'aEmis'] as const;

/** Hinge points (x,y) for wings 1..4 — upper-stbd, lower-stbd, upper-port, lower-port. */
export const WING_PIVOT: [number, number][] = [
  [0.60, 0.32], [0.60, -0.32], [-0.60, 0.32], [-0.60, -0.32],
];
/** Spanwise sign per wing (+1 starboard, -1 port) and vertical sign. */
export const WING_SX = [1, 1, -1, -1];
export const WING_SY = [1, -1, 1, -1];
/** Hinge Z (the wings pivot at the rear of the fuselage). */
export const WING_HINGE_Z = 3.07;

/* ---------------------------------------------------------------- utilities */

/** Force a geometry onto the shared attribute contract. Mutates + returns it. */
export function norm(g: THREE.BufferGeometry, wing = 0, slide = 0, emis = 0): THREE.BufferGeometry {
  let out = g.index ? g.toNonIndexed() : g;
  if (out !== g) g.dispose();
  const n = out.attributes.position.count;
  if (!out.attributes.normal) out.computeVertexNormals();
  if (!out.attributes.uv) out.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  for (const k of Object.keys(out.attributes)) {
    if (k !== 'position' && k !== 'normal' && k !== 'uv') out.deleteAttribute(k);
  }
  const a = new Float32Array(n); a.fill(wing);
  const b = new Float32Array(n); b.fill(slide);
  const c = new Float32Array(n); c.fill(emis);
  out.setAttribute('aWing', new THREE.BufferAttribute(a, 1));
  out.setAttribute('aSlide', new THREE.BufferAttribute(b, 1));
  out.setAttribute('aEmis', new THREE.BufferAttribute(c, 1));
  out.morphAttributes = {};
  return out;
}

/** Rotate + translate a geometry in one go (radians; rotation applied XYZ then translate). */
export function xf(g: THREE.BufferGeometry, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  if (sx !== 1 || sy !== 1 || sz !== 1) g.scale(sx, sy, sz);
  if (rx) g.rotateX(rx);
  if (ry) g.rotateY(ry);
  if (rz) g.rotateZ(rz);
  if (x || y || z) g.translate(x, y, z);
  return g;
}

export function mergeAll(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const list = parts.filter(Boolean);
  if (!list.length) return new THREE.BufferGeometry();
  if (list.length === 1) return list[0];
  const m = mergeGeometries(list, false);
  if (!m) throw new Error('xwing: merge failed (attribute mismatch)');
  for (const p of list) p.dispose();
  return m;
}

export function triCount(g: THREE.BufferGeometry) {
  return (g.index ? g.index.count : g.attributes.position.count) / 3;
}

/* ------------------------------------------------------------------- lofting */

export type Section = { z: number; pts: THREE.Vector2[] };

/**
 * Loft a closed tube through a list of cross-sections lying in constant-z planes.
 * All sections must share a point count. Points wind CCW seen from -Z.
 */
export function loft(sections: Section[], capStart = true, capEnd = true, smooth = true): THREE.BufferGeometry {
  const R = sections.length, P = sections[0].pts.length;
  const pos: number[] = [];
  const uvs: number[] = [];
  const push = (r: number, p: number) => {
    const s = sections[r];
    const v = s.pts[p % P];
    pos.push(v.x, v.y, s.z);
    uvs.push((p % P) / P, r / (R - 1));
  };
  for (let r = 0; r < R - 1; r++) {
    for (let p = 0; p < P; p++) {
      push(r, p); push(r, p + 1); push(r + 1, p + 1);
      push(r, p); push(r + 1, p + 1); push(r + 1, p);
    }
  }
  const capAt = (r: number, flip: boolean) => {
    const s = sections[r];
    let cx = 0, cy = 0;
    for (const v of s.pts) { cx += v.x; cy += v.y; }
    cx /= P; cy /= P;
    for (let p = 0; p < P; p++) {
      const a = s.pts[p], b = s.pts[(p + 1) % P];
      if (flip) { pos.push(cx, cy, s.z, b.x, b.y, s.z, a.x, a.y, s.z); }
      else { pos.push(cx, cy, s.z, a.x, a.y, s.z, b.x, b.y, s.z); }
      uvs.push(0.5, 0.5, 0, 0, 1, 0);
    }
  };
  if (capStart) capAt(0, true);
  if (capEnd) capAt(R - 1, false);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.computeVertexNormals();
  if (!smooth) g.deleteAttribute('normal'), g.computeVertexNormals();
  return g;
}

/** Duplicate a 2D outline scaled to (w,h) — the ship's hull cross-section family. */
export function scaledRing(profile: readonly [number, number][], w: number, h: number, yOff = 0): THREE.Vector2[] {
  return profile.map(([x, y]) => new THREE.Vector2(x * w, y * h + yOff));
}

/**
 * Flat-topped, slab-sided, chisel-bottomed hull section (unit half-extents).
 * Winds CCW looking down -Z.
 */
export const HULL_PROFILE: readonly [number, number][] = (() => {
  const half: [number, number][] = [
    [0.00, 1.00], [0.30, 0.995], [0.58, 0.965], [0.80, 0.870],
    [0.935, 0.660], [1.00, 0.360], [1.00, 0.00], [0.985, -0.300],
    [0.905, -0.585], [0.735, -0.815], [0.470, -0.950], [0.190, -0.995],
  ];
  const pts: [number, number][] = [];
  for (const p of half) pts.push(p);
  for (let i = half.length - 1; i >= 0; i--) { const p = half[i]; if (Math.abs(p[0]) > 1e-4) pts.push([-p[0], p[1]]); }
  return pts;
})();

/** Thin symmetric airfoil half-thickness at chord fraction t (0 = LE, 1 = TE). */
export function airfoilT(t: number): number {
  const c = Math.min(Math.max(t, 0), 1);
  return 1.4845 * Math.sqrt(c) - 0.63 * c - 1.758 * c * c + 1.4215 * c * c * c - 0.5075 * c * c * c * c;
}

/* =========================================================================
   MATERIALS
   ========================================================================= */

export interface ShipUniforms {
  uWingAngle: { value: Float32Array };
  uWingExt: { value: Float32Array };
  uPivotX: { value: Float32Array };
  uPivotY: { value: Float32Array };
  uDomeSpin: { value: number };
  uDomeOrigin: { value: THREE.Vector3 };
  uTime: { value: number };
  uDamage: { value: number };
  uMarkCol: { value: THREE.Color };
  uRedFive: { value: number };
  uSeed: { value: number };
}

export function makeShipUniforms(seed: number, markCol: THREE.Color, redFive: boolean): ShipUniforms {
  const px = new Float32Array(4), py = new Float32Array(4);
  for (let i = 0; i < 4; i++) { px[i] = WING_PIVOT[i][0]; py[i] = WING_PIVOT[i][1]; }
  return {
    uWingAngle: { value: new Float32Array(4) },
    uWingExt: { value: new Float32Array(4) },
    uPivotX: { value: px },
    uPivotY: { value: py },
    uDomeSpin: { value: 0 },
    uDomeOrigin: { value: new THREE.Vector3(0, 0.5, 0.95) },
    uTime: { value: 0 },
    uDamage: { value: 0 },
    uMarkCol: { value: markCol },
    uRedFive: { value: redFive ? 1 : 0 },
    uSeed: { value: seed % 977 },
  };
}

/** Vertex-shader chunk shared by every ship material: s-foil rotation + actuator slide. */
const VS_DECL = /* glsl */ `
attribute float aWing;
attribute float aSlide;
attribute float aEmis;
uniform float uWingAngle[4];
uniform float uWingExt[4];
uniform float uPivotX[4];
uniform float uPivotY[4];
uniform float uDomeSpin;
uniform vec3 uDomeOrigin;
varying vec3 vObjPos;
varying vec3 vObjNrm;
varying float vEmisV;
varying float vWingV;
void xwSelect(float idx, out float ang, out float ext, out vec2 piv){
  ang = 0.0; ext = 0.0; piv = vec2(0.0);
  if(idx > 3.5){ ang = uWingAngle[3]; ext = uWingExt[3]; piv = vec2(uPivotX[3], uPivotY[3]); }
  else if(idx > 2.5){ ang = uWingAngle[2]; ext = uWingExt[2]; piv = vec2(uPivotX[2], uPivotY[2]); }
  else if(idx > 1.5){ ang = uWingAngle[1]; ext = uWingExt[1]; piv = vec2(uPivotX[1], uPivotY[1]); }
  else { ang = uWingAngle[0]; ext = uWingExt[0]; piv = vec2(uPivotX[0], uPivotY[0]); }
}
`;

const VS_NORMAL = /* glsl */ `
#include <beginnormal_vertex>
vObjPos = position;
vObjNrm = objectNormal;
vEmisV = aEmis;
vWingV = aWing;
if(aWing > 4.5){
  float cs = cos(uDomeSpin), sn = sin(uDomeSpin);
  objectNormal.xz = vec2(cs*objectNormal.x + sn*objectNormal.z, -sn*objectNormal.x + cs*objectNormal.z);
} else if(aWing > 0.5){
  float _a, _e; vec2 _p;
  xwSelect(aWing, _a, _e, _p);
  float cs = cos(_a), sn = sin(_a);
  objectNormal.xy = vec2(cs*objectNormal.x - sn*objectNormal.y, sn*objectNormal.x + cs*objectNormal.y);
}
`;

const VS_BEGIN = /* glsl */ `
#include <begin_vertex>
if(aWing > 4.5){
  vec2 dd = transformed.xz - uDomeOrigin.xz;
  float cs = cos(uDomeSpin), sn = sin(uDomeSpin);
  transformed.xz = uDomeOrigin.xz + vec2(cs*dd.x + sn*dd.y, -sn*dd.x + cs*dd.y);
} else if(aWing > 0.5){
  float _a, _e; vec2 _p;
  xwSelect(aWing, _a, _e, _p);
  transformed.x += aSlide * _e;
  vec2 d = transformed.xy - _p;
  float cs = cos(_a), sn = sin(_a);
  transformed.xy = _p + vec2(cs*d.x - sn*d.y, sn*d.x + cs*d.y);
}
`;

/** Object-space procedural surfacing shared by the hull / metal / grille materials. */
const FS_LIB = /* glsl */ `
varying vec3 vObjPos;
varying vec3 vObjNrm;
varying float vEmisV;
varying float vWingV;
uniform float uTime, uDamage, uRedFive, uSeed;
uniform vec3 uMarkCol;
${GLSL_HASH}
${GLSL_NOISE}

// --- rectangular plate layout: returns (edge, plateId, plateTone) --------------
vec3 xwPlates(vec2 uv, float scale, float seed){
  vec2 p = uv * scale + seed;
  // stagger each row so plate seams never run the whole length of a panel
  p.x += 0.37 * floor(p.y) + 0.23 * hash12(vec2(floor(p.y), seed));
  vec2 id = floor(p);
  vec2 f = fract(p);
  float h = hash12(id + seed);
  // two levels of subdivision so plate sizes vary
  if(h > 0.42){
    vec2 q = p * (h > 0.78 ? vec2(3.0, 1.0) : vec2(2.0, 1.0));
    id = floor(q); f = fract(q); h = hash12(id*1.31 + 5.7);
    if(h > 0.45){
      q = q * (h > 0.80 ? vec2(1.0, 3.0) : vec2(1.0, 2.0));
      id = floor(q); f = fract(q); h = hash12(id*2.13 + 11.1);
    }
  }
  vec2 e = min(f, 1.0 - f);
  float d = min(e.x, e.y);
  float w = fwidth(d) * 0.8 + 0.0015;
  float line = 1.0 - smoothstep(0.004, 0.004 + w, d);
  return vec3(line, h, hash12(id * 3.77 + 1.3));
}

// triplanar plate field in OBJECT space so detail never swims
vec3 xwSurface(vec3 p, vec3 n, float scale, float seed){
  vec3 a = abs(normalize(n)); a = pow(a, vec3(4.0)); a /= (a.x + a.y + a.z + 1e-5);
  vec3 rx = xwPlates(p.zy, scale, seed + 0.0);
  vec3 ry = xwPlates(p.xz, scale, seed + 17.0);
  vec3 rz = xwPlates(p.xy, scale, seed + 31.0);
  return rx * a.x + ry * a.y + rz * a.z;
}

// rivet dots along the plate seams
float xwRivets(vec3 p, vec3 n, float scale){
  vec3 a = abs(normalize(n)); a = pow(a, vec3(4.0)); a /= (a.x + a.y + a.z + 1e-5);
  vec2 uv = p.zy * a.x + p.xz * a.y + p.xy * a.z;
  vec2 q = uv * scale * 6.5;
  vec2 c = fract(q) - 0.5;
  float d = length(c);
  vec2 id = floor(q);
  // rivets only sit near a plate seam, in rows
  float keep = step(0.62, hash12(id * 1.7));
  return keep * (1.0 - smoothstep(0.055, 0.115, d));
}

float xwRect(vec2 p, vec2 c, vec2 h, float soft){
  vec2 d = abs(p - c) - h;
  return 1.0 - smoothstep(-soft, soft, max(d.x, d.y));
}
`;

export type ShipMatKind = 'hull' | 'metal' | 'grille';

/**
 * The hero hull shader. Object-space panel plating, rivets, edge wear, engine
 * soot, squadron markings, and a uDamage channel that burns + cracks the paint.
 */
export function createShipMaterial(kind: ShipMatKind, u: ShipUniforms): THREE.MeshStandardMaterial {
  const cfg = {
    hull: { color: 0x9aa1a3, roughness: 0.62, metalness: 0.20, mark: 1.0, plate: 2.30, wear: 1.0 },
    metal: { color: 0x878d92, roughness: 0.42, metalness: 0.72, mark: 0.0, plate: 4.2, wear: 1.05 },
    grille: { color: 0x191d21, roughness: 0.84, metalness: 0.45, mark: 0.0, plate: 3.2, wear: 0.35 },
  }[kind];

  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(cfg.color),
    roughness: cfg.roughness,
    metalness: cfg.metalness,
    // black: three seeds `totalEmissiveRadiance = emissive`, and the injected
    // code below adds the trim lights on top of it
    emissive: new THREE.Color(0x000000),
    emissiveIntensity: 1.0,
    envMapIntensity: 1.7,
  });
  (mat as any).userData.uniforms = u;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.uniforms.uMark = { value: cfg.mark };
    shader.uniforms.uPlateScale = { value: cfg.plate };
    shader.uniforms.uWear = { value: cfg.wear };

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VS_DECL)
      .replace('#include <beginnormal_vertex>', VS_NORMAL)
      .replace('#include <begin_vertex>', VS_BEGIN);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FS_LIB + '\nuniform float uMark, uPlateScale, uWear;')
      .replace('#include <color_fragment>', /* glsl */`
        #include <color_fragment>
        {
          vec3 p = vObjPos;
          vec3 n = normalize(vObjNrm);
          float seed = uSeed;
          vec3 sf = xwSurface(p, n, uPlateScale, seed);
          float line = sf.x;
          float plateTone = sf.y;

          vec3 base = diffuseColor.rgb;
          // per-plate tonal drift + a soft large-scale mottle
          base *= 0.90 + 0.20 * plateTone + 0.10 * vnoise3(p * 0.9 + seed);
          // a coarser structural seam layer on top of the plate grid
          float big = xwSurface(p, n, uPlateScale * 0.34, seed + 61.0).x;
          // recessed seams
          base *= 1.0 - 0.58 * line - 0.22 * big;
          // rivets read as tiny bright/dark specks
          float riv = xwRivets(p, n, uPlateScale);
          base *= 1.0 - 0.26 * riv;

          // ---- edge wear: chamfers (non axis-aligned normals) polish to metal
          float axis = max(abs(n.x), max(abs(n.y), abs(n.z)));
          float edge = pow(1.0 - clamp(axis, 0.0, 1.0), 1.6) * 2.6;
          edge = clamp(edge, 0.0, 1.0) * uWear;
          edge *= 0.45 + 0.55 * vnoise3(p * 6.0 + 13.0);
          base = mix(base, vec3(0.52, 0.53, 0.55), edge * 0.55);

          // ---- grime: dirt caught in the seams and in concave corners
          float grime = fbm3(p * vec3(1.6, 4.0, 0.9) + 4.0, 5, 2.25, 0.55);
          base *= mix(1.0, 0.60 + 0.48 * grime, 0.66);
          base *= 1.0 - 0.42 * line * grime;
          // faint dust settling on upward faces (broad, never blotchy)
          base *= 1.0 - 0.09 * smoothstep(0.2, 1.0, n.y) * fbm3(p * 0.55 + 9.0, 3, 2.2, 0.5);

          // ---- engine soot: streaks trailing aft (+Z) from the nacelles
          float aft = smoothstep(0.6, 4.6, p.z);
          float streak = fbm3(vec3(p.x * 5.0, p.y * 5.0, p.z * 0.55) + 21.0, 4, 2.3, 0.55);
          float soot = aft * smoothstep(0.42, 0.86, streak);
          base *= 1.0 - 0.55 * soot;

          // ---- squadron markings (object space, so they never swim) --------
          if(uMark > 0.5){
            float m = 0.0;
            // nose chevrons: swept stripes over the forward upper decking
            float noseZ = smoothstep(-6.60, -6.35, p.z) * (1.0 - smoothstep(-4.75, -4.45, p.z));
            float chev = step(fract((p.z + 0.55 * abs(p.x)) * 0.92 + 0.30), 0.19);
            m = max(m, noseZ * chev * step(0.10, n.y));
            // chin flash under the chisel
            m = max(m, smoothstep(-6.5, -6.2, p.z) * (1.0 - smoothstep(-5.5, -5.2, p.z))
                       * step(n.y, -0.35) * step(fract(p.z * 1.6 + 0.2), 0.42));
            // wing bands — narrow, clean, outboard of the nacelle only
            if(vWingV > 0.5){
              float ax = abs(p.x);
              float b1 = xwRect(vec2(ax, 0.0), vec2(2.48, 0.0), vec2(0.165, 9.0), 0.012);
              float b2 = xwRect(vec2(ax, 0.0), vec2(4.46, 0.0), vec2(0.115, 9.0), 0.012);
              float band = max(b1, b2) * step(1.75, ax);
              float tip = xwRect(vec2(ax, 0.0), vec2(5.66, 0.0), vec2(0.13, 9.0), 0.012);
              m = max(m, (band + tip) * (1.0 - smoothstep(1.95, 2.20, abs(p.z - 3.05))));
            }
            // fuselage flank blocks + Red Five hash marks by the cockpit
            float side = step(0.55, abs(n.x));
            m = max(m, side * xwRect(p.zy, vec2(1.15, 0.10), vec2(0.62, 0.16), 0.03));
            if(uRedFive > 0.5){
              float rf = xwRect(p.zy, vec2(-0.55, 0.16), vec2(0.30, 0.115), 0.02);
              float bars = step(fract(p.z * 4.2), 0.55);
              m = max(m, side * rf * bars);
            }
            // engine collar band
            m = max(m, xwRect(vec2(p.z, 0.0), vec2(3.02, 0.0), vec2(0.085, 9.0), 0.012)
                       * step(0.5, vWingV) * step(abs(p.x), 1.45) * step(0.62, abs(p.x)));
            // worn edges on the paint: light fade + a little chipping, never blotches
            m *= 0.84 + 0.16 * vnoise3(p * 13.0 + 7.0);
            m *= 1.0 - 0.55 * smoothstep(0.62, 0.90, vnoise3(p * 34.0 + 3.0));
            m *= 1.0 - 0.65 * line;
            base = mix(base, uMarkCol * (0.75 + 0.35 * plateTone), clamp(m, 0.0, 1.0) * 0.92);
          }

          // ---- astromech blue/silver two-tone (object space, tight to the socket)
          {
            float rr = length(p.xz - vec2(0.0, 0.95));
            float r2 = step(0.49, p.y) * (1.0 - smoothstep(0.27, 0.31, rr));
            float ang = fract(atan(p.x, p.z - 0.95) * 0.9549 + 0.12);   // 6 sectors
            // a shoulder band plus every other sector, only on the lower dome
            float lowDome = 1.0 - smoothstep(0.70, 0.86, p.y);
            float sector = step(0.55, ang) * step(ang, 0.80);
            float band = smoothstep(0.55, 0.60, p.y) * (1.0 - smoothstep(0.64, 0.68, p.y));
            base = mix(base, vec3(0.08, 0.22, 0.48), r2 * clamp(band + sector * lowDome, 0.0, 1.0) * 0.92);
          }

          // ---- battle damage: scorching then glowing cracks
          if(uDamage > 0.001){
            float blot = fbm3(p * 1.15 + 31.0, 5, 2.2, 0.55);
            float burn = smoothstep(0.62 - uDamage * 0.34, 0.80 - uDamage * 0.20, blot) * uDamage;
            base = mix(base, vec3(0.045, 0.035, 0.030), clamp(burn * 1.25, 0.0, 0.95));
          }
          diffuseColor.rgb = base;
        }
      `)
      .replace('#include <roughnessmap_fragment>', /* glsl */`
        #include <roughnessmap_fragment>
        {
          vec3 p = vObjPos; vec3 n = normalize(vObjNrm);
          float axis = max(abs(n.x), max(abs(n.y), abs(n.z)));
          float edge = clamp(pow(1.0 - clamp(axis,0.0,1.0), 1.6) * 2.6, 0.0, 1.0) * uWear;
          float rv = vnoise3(p * 2.2 + 3.0);
          float fine = vnoise3(p * 24.0);
          roughnessFactor = clamp(roughnessFactor * (0.80 + 0.42 * rv) + 0.09 * (fine - 0.5), 0.10, 1.0);
          roughnessFactor = mix(roughnessFactor, 0.22, edge * 0.7);
          float aft = smoothstep(0.6, 4.6, p.z);
          roughnessFactor = mix(roughnessFactor, 0.92, aft * 0.35);
        }
      `)
      .replace('#include <metalnessmap_fragment>', /* glsl */`
        #include <metalnessmap_fragment>
        {
          vec3 p = vObjPos; vec3 n = normalize(vObjNrm);
          float axis = max(abs(n.x), max(abs(n.y), abs(n.z)));
          float edge = clamp(pow(1.0 - clamp(axis,0.0,1.0), 1.6) * 2.6, 0.0, 1.0) * uWear;
          metalnessFactor = clamp(metalnessFactor + edge * 0.30, 0.0, 0.92);
        }
      `)
      .replace('#include <emissivemap_fragment>', /* glsl */`
        #include <emissivemap_fragment>
        {
          if(vEmisV > 0.001){
            vec3 c = vec3(1.0, 0.42, 0.14);
            if(vEmisV > 0.85)      c = vec3(0.55, 0.86, 1.25);   // R2 lens / nav strobe
            else if(vEmisV > 0.55) c = vec3(0.35, 1.00, 0.55);   // instrument green
            else if(vEmisV > 0.30) c = vec3(1.00, 0.18, 0.09);   // warning red
            float fl = 0.90 + 0.10 * sin(uTime * (5.0 + vEmisV * 22.0) + vObjPos.x * 9.0);
            totalEmissiveRadiance += c * vEmisV * fl * 3.2;
          }
          if(uDamage > 0.001){
            float cr = ridged3(vObjPos * 1.9 + vec3(0.0, 0.0, uTime * 0.08), 4, 2.3, 0.55);
            float hot = smoothstep(0.74 - uDamage * 0.26, 0.93, cr) * uDamage;
            float pulse = 0.7 + 0.3 * sin(uTime * 7.0 + vObjPos.z * 3.0);
            totalEmissiveRadiance += vec3(4.2, 0.95, 0.14) * hot * pulse * 1.8;
          }
        }
      `);
  };
  mat.customProgramCacheKey = () => 'xwing-ship2-' + kind;
  return mat;
}

/** Canopy glass: faceted, blue-green, clearcoated, visible from inside. */
export function createGlassMaterial(u: ShipUniforms): THREE.MeshPhysicalMaterial {
  const m = new THREE.MeshPhysicalMaterial({
    // deliberately NOT `transmission`: that forces three to re-render the whole
    // scene into a transmission target every frame. A clearcoated, fresnel-
    // weighted transparent shell reads the same at these sizes for one draw call.
    color: new THREE.Color(0x1d3a38),
    metalness: 0.0,
    roughness: 0.04,
    clearcoat: 1.0,
    clearcoatRoughness: 0.015,
    ior: 1.45,
    transparent: true,
    opacity: 0.20,
    depthWrite: false,
    side: THREE.DoubleSide,
    envMapIntensity: 2.6,
    specularIntensity: 1.0,
  });
  (m as any).userData.uniforms = u;
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        varying vec3 vObjPos;
      `)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n vObjPos = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        varying vec3 vObjPos;
        uniform float uDamage;
        ${GLSL_HASH}
        ${GLSL_NOISE}
      `)
      .replace('#include <roughnessmap_fragment>', /* glsl */`
        #include <roughnessmap_fragment>
        {
          // micro-scratches + a dusting of grime along the frame lines
          float sc = vnoise3(vObjPos * vec3(60.0, 8.0, 40.0));
          float dirt = smoothstep(0.55, 1.0, fbm3(vObjPos * 5.0, 3, 2.2, 0.55));
          roughnessFactor = clamp(roughnessFactor + sc * 0.05 + dirt * 0.13 + uDamage * 0.25, 0.02, 0.9);
        }
      `)
      .replace('#include <opaque_fragment>', /* glsl */`
        // fresnel: nearly clear head-on so the tub reads, mirror-bright at grazing angles
        {
          float f = 1.0 - abs(dot(normalize(vViewPosition), normalize(vNormal)));
          diffuseColor.a = clamp(diffuseColor.a + pow(f, 2.6) * 0.62, 0.0, 0.88);
        }
        #include <opaque_fragment>
      `);
  };
  m.customProgramCacheKey = () => 'xwing-glass';
  return m;
}

/* =========================================================================
   ENGINE EXHAUST — one draw call for four plumes + four heat shells,
   one more for the four bell-mouth glow discs.
   ========================================================================= */

export interface PlumeUniforms {
  uWingAngle: { value: Float32Array };
  uPivotX: { value: Float32Array };
  uPivotY: { value: Float32Array };
  uLen: { value: Float32Array };
  uRad: { value: Float32Array };
  uPow: { value: Float32Array };
  uTime: { value: number };
  uNear: { value: number };
}

export function makePlumeUniforms(ship: ShipUniforms): PlumeUniforms {
  return {
    uWingAngle: ship.uWingAngle,
    uPivotX: ship.uPivotX,
    uPivotY: ship.uPivotY,
    uLen: { value: new Float32Array([1, 1, 1, 1]) },
    uRad: { value: new Float32Array([1, 1, 1, 1]) },
    uPow: { value: new Float32Array([1, 1, 1, 1]) },
    uTime: { value: 0 },
    uNear: { value: 1 },
  };
}

const PLUME_SELECT = /* glsl */ `
uniform float uWingAngle[4];
uniform float uPivotX[4];
uniform float uPivotY[4];
uniform float uLen[4];
uniform float uRad[4];
uniform float uPow[4];
void pSelect(float idx, out float ang, out vec2 piv, out float len, out float rad, out float pw){
  if(idx > 3.5){ ang=uWingAngle[3]; piv=vec2(uPivotX[3],uPivotY[3]); len=uLen[3]; rad=uRad[3]; pw=uPow[3]; }
  else if(idx > 2.5){ ang=uWingAngle[2]; piv=vec2(uPivotX[2],uPivotY[2]); len=uLen[2]; rad=uRad[2]; pw=uPow[2]; }
  else if(idx > 1.5){ ang=uWingAngle[1]; piv=vec2(uPivotX[1],uPivotY[1]); len=uLen[1]; rad=uRad[1]; pw=uPow[1]; }
  else { ang=uWingAngle[0]; piv=vec2(uPivotX[0],uPivotY[0]); len=uLen[0]; rad=uRad[0]; pw=uPow[0]; }
}
`;

/** Additive plume cones (aType 0) + the fake-refraction heat shell (aType 1). */
export function createPlumeMaterial(u: PlumeUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: u as any,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    toneMapped: false,
    vertexShader: /* glsl */`
      attribute float aWing;
      attribute float aType;
      attribute float aAxial;
      attribute float aRad;
      attribute vec2 aCen;
      ${PLUME_SELECT}
      varying vec3 vLoc;
      varying float vT, vR, vType, vPow, vIdx;
      void main(){
        float ang, len, rad, pw; vec2 piv;
        pSelect(aWing, ang, piv, len, rad, pw);
        vec3 p = position;
        vec2 d = (p.xy - aCen) * rad;
        vLoc = vec3(d, aAxial);
        p.xy = aCen + d;
        p.z += aAxial * (len - 1.0);
        vec2 q = p.xy - piv;
        float cs = cos(ang), sn = sin(ang);
        p.xy = piv + vec2(cs*q.x - sn*q.y, sn*q.x + cs*q.y);
        vT = aAxial; vR = aRad; vType = aType; vPow = pw; vIdx = aWing;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      precision highp float;
      uniform float uTime;
      varying vec3 vLoc;
      varying float vT, vR, vType, vPow, vIdx;
      ${GLSL_HASH}
      ${GLSL_NOISE}
      ${GLSL_COLOR}
      void main(){
        float t = clamp(vT, 0.0, 1.0);
        float r = clamp(vR, 0.0, 1.0);
        float sd = vIdx * 7.31;
        // turbulence scrolling backwards down the plume
        vec3 np = vec3(vLoc.xy * 16.0, vLoc.z * 7.5 - uTime * 11.0 + sd);
        float n  = fbm3(np, 4, 2.35, 0.55);
        float rg = ridged3(np * vec3(1.7, 1.7, 0.9) + 17.0 + sd, 4, 2.25, 0.52);

        if(vType > 0.5){
          // --- heat-shimmer shell: near-transparent, warped, no colour of its own
          float shim = fbm3(vec3(vLoc.xy * 22.0, vLoc.z * 9.0 - uTime * 14.0 + sd), 3, 2.4, 0.5);
          float body = (1.0 - t) * (1.0 - t) * smoothstep(0.0, 0.18, t);
          float a = body * (0.18 + 0.95 * shim * shim) * (1.0 - r * 0.6) * 0.028 * vPow;
          vec3 c = mix(vec3(0.70, 0.52, 0.40), vec3(1.0, 0.68, 0.34), shim);
          gl_FragColor = vec4(c * a * 1.5, a);
          return;
        }

        // --- core plume
        float radial = exp(-r * r * 4.4);
        float taper = pow(1.0 - t, 1.9);
        float lick = 0.30 + 0.85 * n + 0.85 * rg * smoothstep(0.10, 0.85, t);
        float a = radial * taper * lick * 0.46;
        a *= smoothstep(0.0, 0.13, t);                  // ease out of the bell lip
        a = clamp(a, 0.0, 1.2);

        float heat = clamp(radial * 1.5 * (1.0 - t * 0.70) * (0.45 + 0.80 * n), 0.0, 1.0);
        vec3 col = plasmaRamp(heat,
                     vec3(0.78, 0.93, 1.45),            // white-blue core
                     vec3(1.00, 0.58, 0.20),            // orange mantle
                     vec3(1.00, 0.24, 0.04));           // red fringe
        col = mix(col, vec3(1.35, 1.45, 1.60), smoothstep(0.72, 1.0, heat));
        float hdr = (1.5 + 4.2 * vPow);
        gl_FragColor = vec4(col * a * hdr, a);
      }
    `,
  });
}

/** Camera-facing additive glow disc sitting in each engine bell mouth. */
export function createGlowMaterial(u: PlumeUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: u as any,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    vertexShader: /* glsl */`
      attribute float aWing;
      attribute float aSize;
      attribute vec2 aCorner;
      ${PLUME_SELECT}
      varying vec2 vC;
      varying float vPow, vIdx;
      void main(){
        float ang, len, rad, pw; vec2 piv;
        pSelect(aWing, ang, piv, len, rad, pw);
        vec3 p = position;
        vec2 q = p.xy - piv;
        float cs = cos(ang), sn = sin(ang);
        p.xy = piv + vec2(cs*q.x - sn*q.y, sn*q.x + cs*q.y);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        mv.xy += aCorner * aSize * (0.55 + 0.55 * pw);
        vC = aCorner; vPow = pw; vIdx = aWing;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */`
      precision highp float;
      uniform float uTime, uNear;
      varying vec2 vC;
      varying float vPow, vIdx;
      void main(){
        float d = length(vC);
        if(d > 1.0) discard;
        float core = pow(1.0 - d, 2.6);
        float halo = pow(1.0 - d, 0.9) * 0.30;
        float fl = 0.90 + 0.10 * sin(uTime * 41.0 + vIdx * 2.1) + 0.06 * sin(uTime * 13.7 + vIdx);
        float a = (core + halo) * fl;
        vec3 c = mix(vec3(1.00, 0.42, 0.12), vec3(0.85, 0.94, 1.30), core);
        gl_FragColor = vec4(c * a * (1.1 + 4.4 * vPow), a);
      }
    `,
  });
}

/* ------- geometry builders for the exhaust meshes (ship-space, unit length) - */

type VFXBuf = {
  pos: number[]; wing: number[]; type: number[]; axial: number[]; rad: number[]; cen: number[];
};

function vfxPush(b: VFXBuf, x: number, y: number, z: number, w: number, ty: number, ax: number, rd: number, cx: number, cy: number) {
  b.pos.push(x, y, z); b.wing.push(w); b.type.push(ty); b.axial.push(ax); b.rad.push(rd); b.cen.push(cx, cy);
}

/**
 * Cone/plume shell for one engine. Apex ring at the bell mouth (z0), running to
 * z0+1 (the vertex shader stretches it). `profile` gives radius vs axial t.
 */
function plumeShell(b: VFXBuf, wing: number, type: number, cx: number, cy: number, z0: number,
  r0: number, r1: number, seg: number, rings: number, rFrac = 1) {
  const rAt = (t: number) => {
    // bulge just aft of the bell then taper to a point
    const bulge = 1.0 + 0.55 * Math.sin(Math.PI * Math.min(t * 2.4, 1)) * (1 - t);
    return (r0 + (r1 - r0) * Math.pow(t, 0.72)) * bulge;
  };
  for (let i = 0; i < rings; i++) {
    const t0 = i / rings, t1 = (i + 1) / rings;
    const ra = rAt(t0), rb = rAt(t1);
    for (let s = 0; s < seg; s++) {
      const a0 = (s / seg) * Math.PI * 2, a1 = ((s + 1) / seg) * Math.PI * 2;
      const p = (a: number, r: number, t: number, rr: number) =>
        vfxPush(b, cx + Math.cos(a) * r, cy + Math.sin(a) * r, z0 + t, wing, type, t, rr, cx, cy);
      const rr = rFrac;
      p(a0, ra, t0, rr); p(a1, ra, t0, rr); p(a1, rb, t1, rr);
      p(a0, ra, t0, rr); p(a1, rb, t1, rr); p(a0, rb, t1, rr);
    }
  }
}

export function buildExhaustGeometry(engines: { wing: number; x: number; y: number; z: number; r: number }[], hero = true): THREE.BufferGeometry {
  const b: VFXBuf = { pos: [], wing: [], type: [], axial: [], rad: [], cen: [] };
  for (const e of engines) {
    if (!hero) {
      plumeShell(b, e.wing, 0, e.x, e.y, e.z, e.r * 0.42, e.r * 0.07, 8, 8, 0.34);
      plumeShell(b, e.wing, 0, e.x, e.y, e.z, e.r * 0.94, e.r * 0.20, 10, 8, 0.92);
      continue;
    }
    // three nested shells: hot narrow core, main body, soft outer envelope
    plumeShell(b, e.wing, 0, e.x, e.y, e.z, e.r * 0.20, e.r * 0.03, 12, 20, 0.16);
    plumeShell(b, e.wing, 0, e.x, e.y, e.z, e.r * 0.44, e.r * 0.07, 14, 20, 0.40);
    plumeShell(b, e.wing, 0, e.x, e.y, e.z, e.r * 0.70, e.r * 0.12, 18, 20, 0.66);
    plumeShell(b, e.wing, 0, e.x, e.y, e.z, e.r * 0.96, e.r * 0.22, 20, 20, 0.94);
    plumeShell(b, e.wing, 1, e.x, e.y, e.z - 0.02, e.r * 1.45, e.r * 0.50, 14, 10, 0.85);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
  g.setAttribute('aWing', new THREE.Float32BufferAttribute(b.wing, 1));
  g.setAttribute('aType', new THREE.Float32BufferAttribute(b.type, 1));
  g.setAttribute('aAxial', new THREE.Float32BufferAttribute(b.axial, 1));
  g.setAttribute('aRad', new THREE.Float32BufferAttribute(b.rad, 1));
  g.setAttribute('aCen', new THREE.Float32BufferAttribute(b.cen, 2));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 4), 16);
  return g;
}

export function buildGlowGeometry(engines: { wing: number; x: number; y: number; z: number; r: number }[]): THREE.BufferGeometry {
  const pos: number[] = [], wing: number[] = [], size: number[] = [], corner: number[] = [];
  for (const e of engines) {
    const quad: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]];
    for (const c of quad) {
      pos.push(e.x, e.y, e.z - 0.03);
      wing.push(e.wing); size.push(e.r * 2.0); corner.push(c[0], c[1]);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aWing', new THREE.Float32BufferAttribute(wing, 1));
  g.setAttribute('aSize', new THREE.Float32BufferAttribute(size, 1));
  g.setAttribute('aCorner', new THREE.Float32BufferAttribute(corner, 2));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 4), 12);
  return g;
}

/* =========================================================================
   GEOMETRY
   Everything is authored in ship space with the s-foils CLOSED; the wing
   vertices carry aWing = 1..4 and are rotated by the vertex shader.
   ========================================================================= */

export interface Bins {
  hull: THREE.BufferGeometry[];
  metal: THREE.BufferGeometry[];
  grille: THREE.BufferGeometry[];
  glass: THREE.BufferGeometry[];
}

export interface EngineDesc { wing: number; x: number; y: number; z: number; r: number }

/* ---- local primitives (centred on the origin, +Z = aft) ------------------- */

/** Set for the whole of a `detail:'lod'` build: drops chamfers and segment counts. */
let LOW = false;

const bx = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);

/** Chamfered box — the workhorse. Reads far better than a raw box under a key light. */
function cbox(w: number, h: number, d: number, c = 0.035): THREE.BufferGeometry {
  if (LOW) return new THREE.BoxGeometry(w, h, d);     // 12 tris instead of ~44
  const cc = Math.max(0.004, Math.min(c, w * 0.32, h * 0.32, d * 0.32));
  const s = new THREE.Shape();
  const hw = w / 2 - cc, hh = h / 2 - cc;
  s.moveTo(-hw, -h / 2); s.lineTo(hw, -h / 2); s.lineTo(w / 2, -hh);
  s.lineTo(w / 2, hh); s.lineTo(hw, h / 2); s.lineTo(-hw, h / 2);
  s.lineTo(-w / 2, hh); s.lineTo(-w / 2, -hh); s.closePath();
  const g = new THREE.ExtrudeGeometry(s, {
    depth: d - 2 * cc, bevelEnabled: true, bevelThickness: cc, bevelSize: cc,
    bevelSegments: 1, curveSegments: 1, steps: 1,
  });
  g.translate(0, 0, -(d - 2 * cc) / 2);
  return g;
}

/** Cylinder along Z. r0 = radius at -Z, r1 = radius at +Z. */
function cyZ(r0: number, r1: number, len: number, seg = 14, open = false): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r1, r0, len, LOW ? Math.min(seg, 6) : seg, 1, open);
  g.rotateX(Math.PI / 2);
  return g;
}
/** Cylinder along X. */
function cyX(r0: number, r1: number, len: number, seg = 12, open = false): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r1, r0, len, LOW ? Math.min(seg, 6) : seg, 1, open);
  g.rotateZ(-Math.PI / 2);
  return g;
}
const sph = (r: number, a = 12, b = 8) => new THREE.SphereGeometry(r, LOW ? Math.min(a, 7) : a, LOW ? Math.min(b, 5) : b);

/* ---- fuselage cross-section family ---------------------------------------- */

type PP = [number, number, number];  // x, y, crease
const HALF: PP[] = [
  [0.000, 1.000, 0], [0.145, 0.999, 0], [0.300, 0.992, 1], [0.440, 0.978, 1],
  [0.560, 0.955, 1], [0.790, 0.868, 1], [0.930, 0.665, 1], [1.000, 0.375, 1],
  [1.000, 0.010, 0], [0.988, -0.300, 1], [0.902, -0.585, 1], [0.735, -0.808, 1],
  [0.470, -0.942, 1], [0.185, -0.996, 0],
];
/** Nose variant: flatter chisel underside, sharper cheeks. */
const HALF_NOSE: PP[] = [
  [0.000, 0.980, 0], [0.200, 0.978, 0], [0.400, 0.972, 1], [0.580, 0.958, 1],
  [0.760, 0.905, 1], [0.940, 0.770, 1], [1.000, 0.530, 1], [1.000, 0.180, 1],
  [0.975, -0.115, 1], [0.870, -0.335, 1], [0.700, -0.470, 0], [0.480, -0.552, 0],
  [0.260, -0.592, 1], [0.090, -0.602, 0],
];

function ringFrom(half: PP[]): PP[] {
  const out: PP[] = half.map((p) => [p[0], p[1], p[2]]);
  for (let i = half.length - 1; i >= 1; i--) out.push([-half[i][0], half[i][1], half[i][2]]);
  return out;
}
const RING = ringFrom(HALF);
const RING_NOSE = ringFrom(HALF_NOSE);
const CREASE = RING.map((p) => p[2] > 0.5);

/** Loft with per-column crease control — smooth along the length, hard at the corners. */
function loftCreased(sections: { z: number; pts: THREE.Vector2[] }[], creases: boolean[],
  capStart: boolean, capEnd: boolean): THREE.BufferGeometry {
  const R = sections.length, P = sections[0].pts.length;
  // expand columns: a creased column is duplicated so the two sides do not share normals
  const cols: number[] = [];
  for (let p = 0; p < P; p++) { cols.push(p); if (creases[p]) cols.push(p); }
  const C = cols.length;
  const pos = new Float32Array(R * C * 3);
  const uv = new Float32Array(R * C * 2);
  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) {
      const v = sections[r].pts[cols[c]];
      const i = (r * C + c);
      pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = sections[r].z;
      uv[i * 2] = c / C; uv[i * 2 + 1] = r / (R - 1);
    }
  }
  const idx: number[] = [];
  for (let r = 0; r < R - 1; r++) {
    for (let c = 0; c < C; c++) {
      const c1 = (c + 1) % C;
      const a = r * C + c, b = r * C + c1, d = (r + 1) * C + c, e = (r + 1) * C + c1;
      idx.push(a, e, b, a, d, e);
    }
  }
  const centre = (r: number, flip: boolean, base: number) => {
    let cx = 0, cy = 0;
    for (let c = 0; c < C; c++) { cx += pos[(r * C + c) * 3]; cy += pos[(r * C + c) * 3 + 1]; }
    cx /= C; cy /= C;
    extra.push(cx, cy, sections[r].z);
    const ci = base;
    for (let c = 0; c < C; c++) {
      const c1 = (c + 1) % C;
      if (flip) idx.push(ci, r * C + c1, r * C + c);
      else idx.push(ci, r * C + c, r * C + c1);
    }
  };
  const extra: number[] = [];
  let base = R * C;
  if (capStart) { centre(0, false, base); base++; }
  if (capEnd) { centre(R - 1, true, base); base++; }

  const allPos = new Float32Array(pos.length + extra.length);
  allPos.set(pos); allPos.set(extra, pos.length);
  const allUv = new Float32Array(allPos.length / 3 * 2);
  allUv.set(uv);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(allPos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(allUv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/* ---- the fuselage --------------------------------------------------------- */

type Key = { z: number; w: number; h: number; y: number; nose: number };
const KEYS: Key[] = [
  { z: -7.30, w: 0.175, h: 0.150, y: -0.004, nose: 1 },
  { z: -7.14, w: 0.222, h: 0.188, y: -0.009, nose: 1 },
  { z: -6.86, w: 0.278, h: 0.230, y: -0.016, nose: 1 },
  { z: -6.42, w: 0.340, h: 0.274, y: -0.026, nose: 1 },
  { z: -5.85, w: 0.402, h: 0.315, y: -0.038, nose: 1 },
  { z: -5.20, w: 0.456, h: 0.350, y: -0.048, nose: 0.95 },
  { z: -4.45, w: 0.505, h: 0.381, y: -0.057, nose: 0.82 },
  { z: -3.70, w: 0.543, h: 0.403, y: -0.062, nose: 0.63 },
  { z: -2.95, w: 0.573, h: 0.418, y: -0.060, nose: 0.44 },
  { z: -2.25, w: 0.598, h: 0.430, y: -0.052, nose: 0.27 },
  { z: -1.60, w: 0.618, h: 0.445, y: -0.042, nose: 0.12 },
  { z: -1.05, w: 0.641, h: 0.469, y: -0.030, nose: 0.04 },
  { z: -0.45, w: 0.660, h: 0.489, y: -0.018, nose: 0 },
  { z: 0.15, w: 0.674, h: 0.505, y: -0.008, nose: 0 },
  { z: 0.75, w: 0.684, h: 0.518, y: 0.000, nose: 0 },
  { z: 1.40, w: 0.691, h: 0.529, y: 0.004, nose: 0 },
  { z: 2.05, w: 0.694, h: 0.538, y: 0.008, nose: 0 },
  { z: 2.70, w: 0.692, h: 0.543, y: 0.010, nose: 0 },
  { z: 3.35, w: 0.681, h: 0.542, y: 0.010, nose: 0 },
  { z: 3.95, w: 0.660, h: 0.531, y: 0.008, nose: 0 },
  { z: 4.50, w: 0.628, h: 0.508, y: 0.004, nose: 0 },
  { z: 4.90, w: 0.590, h: 0.478, y: 0.000, nose: 0 },
  { z: 5.08, w: 0.545, h: 0.440, y: 0.000, nose: 0 },
];

function keyAt(z: number): Key {
  if (z <= KEYS[0].z) return KEYS[0];
  if (z >= KEYS[KEYS.length - 1].z) return KEYS[KEYS.length - 1];
  for (let i = 0; i < KEYS.length - 1; i++) {
    const a = KEYS[i], b = KEYS[i + 1];
    if (z >= a.z && z <= b.z) {
      const t = (z - a.z) / (b.z - a.z);
      const s = t * t * (3 - 2 * t);
      return { z, w: a.w + (b.w - a.w) * s, h: a.h + (b.h - a.h) * s, y: a.y + (b.y - a.y) * s, nose: a.nose + (b.nose - a.nose) * s };
    }
  }
  return KEYS[KEYS.length - 1];
}

/**
 * Exact point + outward normal on the lofted hull at (z, ring index). Greebles
 * seeded with this sit flush; picking `w*0.97` on a curved flank makes them float.
 */
function hullSurface(z: number, idx: number): { x: number; y: number; nx: number; ny: number } {
  const k = keyAt(z);
  const P = RING.length;
  const at = (i: number) => {
    const a = RING[(i + P) % P], nn = RING_NOSE[(i + P) % P];
    return [
      (a[0] + (nn[0] - a[0]) * k.nose) * k.w,
      (a[1] + (nn[1] - a[1]) * k.nose) * k.h + k.y,
    ] as [number, number];
  };
  const c = at(idx), a = at(idx - 1), b = at(idx + 1);
  const tx = b[0] - a[0], ty = b[1] - a[1];
  const L = Math.hypot(tx, ty) || 1;
  // the ring winds clockwise seen from +Z, so the outward normal is (ty, -tx)
  return { x: c[0], y: c[1], nx: ty / L, ny: -tx / L };
}

const COCKPIT_Z0 = -1.98, COCKPIT_Z1 = 0.28;   // tub mouth (with ramps)
const TUB_FLOOR = 0.055;

/** How deep the top deck is scooped out at this z (0 = closed deck, 1 = full tub). */
function tubDepth(z: number): number {
  const a = (z - COCKPIT_Z0) / 0.36;
  const b = (COCKPIT_Z1 - z) / 0.30;
  return Math.max(0, Math.min(1, Math.min(a, b)));
}

const NO_CREASE = RING.map(() => false);

function fuselageGeometry(): THREE.BufferGeometry {
  const zs: number[] = [];
  for (let i = 0; i < KEYS.length; i++) if (!LOW || i % 2 === 0 || i === KEYS.length - 1) zs.push(KEYS[i].z);
  // densify through the cockpit so the tub walls are clean
  for (let z = COCKPIT_Z0 - 0.12; z <= COCKPIT_Z1 + 0.16; z += (LOW ? 0.5 : 0.14)) zs.push(z);
  zs.sort((a, b) => a - b);
  const uniq = zs.filter((z, i) => i === 0 || z - zs[i - 1] > 1e-3);

  const sections = uniq.map((z) => {
    const k = keyAt(z);
    const pts: THREE.Vector2[] = [];
    for (let i = 0; i < RING.length; i++) {
      const a = RING[i], n = RING_NOSE[i];
      const px = a[0] + (n[0] - a[0]) * k.nose;
      const py = a[1] + (n[1] - a[1]) * k.nose;
      pts.push(new THREE.Vector2(px * k.w, py * k.h + k.y));
    }
    // scoop the cockpit tub out of the top decking
    const d = tubDepth(z);
    if (d > 0) {
      const deck = k.h + k.y;
      for (let i = 0; i < pts.length; i++) {
        const v = pts[i];
        const ax = Math.abs(v.x);
        if (v.y > deck * 0.45 && ax < k.w * 0.62) {
          const inner = 1 - Math.min(1, Math.max(0, (ax - k.w * 0.40) / (k.w * 0.20)));
          const target = TUB_FLOOR + (1 - inner) * 0.14;
          v.y = v.y + (target - v.y) * d * inner;
        }
      }
    }
    return { z, pts };
  });
  return loftCreased(sections, LOW ? NO_CREASE : CREASE, true, true);
}

/* ---- open lofted sheet (canopy glass, fairings) ---------------------------- */

function sheet(sections: { z: number; pts: THREE.Vector2[] }[]): THREE.BufferGeometry {
  const R = sections.length, P = sections[0].pts.length;
  const pos = new Float32Array(R * P * 3), uv = new Float32Array(R * P * 2);
  for (let r = 0; r < R; r++) for (let p = 0; p < P; p++) {
    const v = sections[r].pts[p], i = r * P + p;
    pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = sections[r].z;
    uv[i * 2] = p / (P - 1); uv[i * 2 + 1] = r / (R - 1);
  }
  const idx: number[] = [];
  for (let r = 0; r < R - 1; r++) for (let p = 0; p < P - 1; p++) {
    const a = r * P + p, b = r * P + p + 1, c = (r + 1) * P + p, d = (r + 1) * P + p + 1;
    idx.push(a, b, d, a, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * Rectangular tube swept along a 3D polyline — used for canopy ribs and cable
 * runs, where a chain of rotated boxes always ends up visibly kinked.
 */
function tubeAlong(pts: THREE.Vector3[], w: number, h: number): THREE.BufferGeometry {
  const N = pts.length;
  const up = new THREE.Vector3(0, 1, 0);
  const tan = new THREE.Vector3(), nrm = new THREE.Vector3(), bin = new THREE.Vector3();
  const pos: number[] = [];
  const ring: THREE.Vector3[][] = [];
  for (let i = 0; i < N; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(N - 1, i + 1)];
    tan.subVectors(b, a).normalize();
    if (Math.abs(tan.dot(up)) > 0.97) nrm.set(1, 0, 0); else nrm.copy(up);
    bin.crossVectors(tan, nrm).normalize();
    nrm.crossVectors(bin, tan).normalize();
    const c = pts[i];
    ring.push([
      new THREE.Vector3().copy(c).addScaledVector(bin, -w / 2).addScaledVector(nrm, -h / 2),
      new THREE.Vector3().copy(c).addScaledVector(bin, w / 2).addScaledVector(nrm, -h / 2),
      new THREE.Vector3().copy(c).addScaledVector(bin, w / 2).addScaledVector(nrm, h / 2),
      new THREE.Vector3().copy(c).addScaledVector(bin, -w / 2).addScaledVector(nrm, h / 2),
    ]);
  }
  const quad = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3) => {
    pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    pos.push(a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z);
  };
  for (let i = 0; i < N - 1; i++) {
    const r0 = ring[i], r1 = ring[i + 1];
    for (let k = 0; k < 4; k++) quad(r0[k], r0[(k + 1) % 4], r1[(k + 1) % 4], r1[k]);
  }
  quad(ring[0][3], ring[0][2], ring[0][1], ring[0][0]);
  quad(ring[N - 1][0], ring[N - 1][1], ring[N - 1][2], ring[N - 1][3]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** Mirror a NON-INDEXED geometry across X and/or Y, fixing winding + normals. */
function mirrorGeo(src: THREE.BufferGeometry, sx: number, sy: number, wing: number, slideSign: number): THREE.BufferGeometry {
  const g = src.clone();
  const pa = (g.attributes.position as THREE.BufferAttribute).array as Float32Array;
  const na = (g.attributes.normal as THREE.BufferAttribute).array as Float32Array;
  for (let i = 0; i < pa.length; i += 3) {
    pa[i] *= sx; pa[i + 1] *= sy; na[i] *= sx; na[i + 1] *= sy;
  }
  if (sx * sy < 0) {
    const uvv = (g.attributes.uv as THREE.BufferAttribute).array as Float32Array;
    for (let i = 0; i < pa.length; i += 9) {
      for (let k = 0; k < 3; k++) {
        let t = pa[i + 3 + k]; pa[i + 3 + k] = pa[i + 6 + k]; pa[i + 6 + k] = t;
        t = na[i + 3 + k]; na[i + 3 + k] = na[i + 6 + k]; na[i + 6 + k] = t;
      }
      const j = (i / 3) * 2;
      for (let k = 0; k < 2; k++) {
        const t = uvv[j + 2 + k]; uvv[j + 2 + k] = uvv[j + 4 + k]; uvv[j + 4 + k] = t;
      }
    }
  }
  const w = (g.attributes.aWing as THREE.BufferAttribute).array as Float32Array;
  const s = (g.attributes.aSlide as THREE.BufferAttribute).array as Float32Array;
  for (let i = 0; i < w.length; i++) { if (w[i] > 0.5) w[i] = wing; s[i] = s[i] !== 0 ? slideSign : 0; }
  return g;
}

/* =========================================================================
   NOSE / FORWARD FUSELAGE DETAIL
   ========================================================================= */

function buildNose(B: Bins, rng: RNG, hero: boolean) {
  const H = (g: THREE.BufferGeometry, e = 0) => B.hull.push(norm(g, 0, 0, e));
  const M = (g: THREE.BufferGeometry, e = 0) => B.metal.push(norm(g, 0, 0, e));
  const G = (g: THREE.BufferGeometry, e = 0) => B.grille.push(norm(g, 0, 0, e));

  // ---- fine grid nose-tip cluster (the T-65 sensor rake)
  H(xf(cyZ(0.070, 0.112, 0.15, 14), 0, -0.006, -7.33));
  M(xf(cyZ(0.030, 0.058, 0.09, 10), 0, -0.006, -7.43));
  G(xf(cyZ(0.024, 0.024, 0.02, 10), 0, -0.006, -7.49), 0.30);
  if (hero) for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    M(xf(bx(0.016, 0.016, 0.20), Math.cos(a) * 0.078, -0.006 + Math.sin(a) * 0.068, -7.24));
  }
  if (hero) {
    for (let i = 0; i < 3; i++) {
      const z = -6.98 + i * 0.16;
      const k = keyAt(z);
      G(xf(bx(k.w * 1.55, 0.012, 0.030), 0, k.y - 0.012, z));
      G(xf(bx(0.012, k.h * 1.5, 0.030), 0, k.y - 0.012, z));
    }
    // fine radial grid disc
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI;
      const g = bx(0.11, 0.006, 0.006); g.rotateZ(a);
      M(xf(g, 0, -0.012, -6.86));
    }
  }

  // ---- sensor "cheek" blisters
  for (const sx of [-1, 1]) {
    const k = keyAt(-5.35);
    const b = sph(0.105, hero ? 14 : 8, hero ? 10 : 6);
    b.scale(0.85, 0.72, 2.05);
    H(xf(b, sx * (k.w * 0.86), k.y + k.h * 0.10, -5.35));
    const lens = sph(0.052, 10, 7); lens.scale(0.5, 0.8, 0.8);
    G(xf(lens, sx * (k.w * 1.02), k.y + k.h * 0.10, -5.62), 0.95);
    // small blister behind
    H(xf(sph(0.055, 10, 7).scale(0.9, 0.7, 1.5), sx * (k.w * 0.80), k.y - k.h * 0.42, -4.70));
  }

  if (!hero) return;
  // ---- chisel underside strake + chin sensor housing
  for (let i = 0; i < 7; i++) {
    const z = -6.55 + i * 0.62;
    const k = keyAt(z);
    H(xf(cbox(k.w * 0.62, 0.030, 0.44, 0.012), 0, k.y - k.h * 0.965, z));
  }
  M(xf(cbox(0.20, 0.10, 0.62, 0.028), 0, keyAt(-4.2).y - keyAt(-4.2).h * 0.92, -4.20));
  G(xf(cyZ(0.055, 0.055, 0.05, 12), 0, keyAt(-4.45).y - keyAt(-4.45).h * 0.92 - 0.035, -4.50), 0.35);

  // ---- raised spine panels running forward of the cockpit
  for (let i = 0; i < 6; i++) {
    const z = -5.95 + i * 0.66;
    const k = keyAt(z);
    const w = k.w * (0.52 - i * 0.012);
    H(xf(cbox(w, 0.026, 0.52, 0.012), 0, k.y + k.h * 0.975, z));
  }
  // gun-camera housing on the spine
  M(xf(cbox(0.10, 0.075, 0.24, 0.02), 0.0, keyAt(-2.55).y + keyAt(-2.55).h + 0.045, -2.55));
  G(xf(cyZ(0.032, 0.032, 0.03, 10), 0.0, keyAt(-2.70).y + keyAt(-2.70).h + 0.045, -2.70), 0.9);

  // ---- recessed side channels
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 5; i++) {
      const z = -4.9 + i * 0.72;
      const k = keyAt(z);
      const idx = sx > 0 ? 7 : RING.length - 7;
      const sp = hullSurface(z, idx);
      const rz = Math.atan2(sp.ny, sp.nx) - Math.PI / 2;
      G(xf(cbox(0.022, k.h * 0.28, 0.56, 0.006), sp.x, sp.y, z, 0, 0, rz));
      if (i % 2 === 0) M(xf(cbox(0.030, k.h * 0.15, 0.16, 0.008), sp.x + sp.nx * 0.012, sp.y + sp.ny * 0.012, z + 0.24, 0, 0, rz));
    }
  }
}

/* =========================================================================
   COCKPIT + CANOPY
   ========================================================================= */

export const COCKPIT_EYE = new THREE.Vector3(0, 0.60, -0.92);

function canopySections(): { z: number; pts: THREE.Vector2[] }[] {
  const keys: [number, number, number][] = [   // z, halfWidth, height above deck
    [-2.02, 0.135, 0.030],
    [-1.80, 0.225, 0.130],
    [-1.48, 0.300, 0.255],
    [-1.05, 0.345, 0.360],
    [-0.55, 0.362, 0.415],
    [0.00, 0.360, 0.430],
    [0.24, 0.330, 0.360],
    [0.40, 0.280, 0.210],
  ];
  return keys.map(([z, w, h]) => {
    const k = keyAt(z);
    const base = k.y + k.h * 0.985;
    const pts: THREE.Vector2[] = [
      new THREE.Vector2(-w, base),
      new THREE.Vector2(-w * 0.935, base + h * 0.56),
      new THREE.Vector2(-w * 0.500, base + h),
      new THREE.Vector2(w * 0.500, base + h),
      new THREE.Vector2(w * 0.935, base + h * 0.56),
      new THREE.Vector2(w, base),
    ];
    return { z, pts };
  });
}

function buildCockpit(B: Bins, rng: RNG, hero: boolean) {
  const H = (g: THREE.BufferGeometry, e = 0) => B.hull.push(norm(g, 0, 0, e));
  const M = (g: THREE.BufferGeometry, e = 0) => B.metal.push(norm(g, 0, 0, e));
  const G = (g: THREE.BufferGeometry, e = 0) => B.grille.push(norm(g, 0, 0, e));

  // ---- coaming: side rails + end lips, NOT a plate across the tub mouth
  const cs = canopySections();
  for (let i = 0; i < cs.length - 1; i++) {
    const a = cs[i], b = cs[i + 1];
    const zc = (a.z + b.z) / 2, d = b.z - a.z;
    const yb = (a.pts[0].y + b.pts[0].y) / 2;
    for (const sgn of [-1, 1]) {
      const w = (Math.abs(a.pts[5].x) + Math.abs(b.pts[5].x)) * 0.5;
      H(xf(cbox(0.085, 0.040, d * 1.02, 0.012), sgn * (w + 0.026), yb + 0.008, zc));
    }
  }
  H(xf(cbox(0.34, 0.045, 0.16, 0.014), 0, cs[0].pts[0].y + 0.010, cs[0].z + 0.02));
  H(xf(cbox(0.58, 0.045, 0.20, 0.014), 0, cs[cs.length - 1].pts[0].y + 0.010, cs[cs.length - 1].z - 0.02));

  if (hero) {
    // ---- dark liner so the tub does not read as bright hull plate
    G(xf(cbox(0.60, 0.012, 2.05, 0.010), 0, TUB_FLOOR + 0.030, -0.80));
    for (const sx of [-1, 1]) {
      const wall = cbox(0.014, 0.42, 2.05, 0.006); wall.rotateZ(sx * 0.10);
      G(xf(wall, sx * 0.298, 0.235, -0.80));
    }
    G(xf(cbox(0.58, 0.40, 0.014, 0.008), 0, 0.235, 0.245));      // rear bulkhead
    G(xf(cbox(0.58, 0.40, 0.014, 0.008), 0, 0.235, -1.845));     // forward bulkhead
    // ---- tub interior: side consoles, floor grating, rear bulkhead
    for (const sx of [-1, 1]) {
      M(xf(cbox(0.075, 0.155, 1.42, 0.016), sx * 0.245, 0.185, -0.86));
      G(xf(cbox(0.048, 0.048, 1.20, 0.008), sx * 0.208, 0.245, -0.86), 0.66);
    }
    G(xf(bx(0.50, 0.014, 1.55), 0, TUB_FLOOR + 0.008, -0.82), 0.10);
    for (let i = 0; i < 7; i++) G(xf(bx(0.46, 0.010, 0.030), 0, TUB_FLOOR + 0.018, -1.52 + i * 0.22));

    // ---- instrument panel + coaming hood, canted back
    const ip = cbox(0.44, 0.20, 0.055, 0.012); ip.rotateX(-0.42);
    M(xf(ip, 0, 0.215, -1.52));
    const scr = bx(0.36, 0.145, 0.010); scr.rotateX(-0.42);
    G(xf(scr, 0, 0.222, -1.556), 0.72);
    const hood = cbox(0.50, 0.035, 0.16, 0.012); hood.rotateX(-0.30);
    H(xf(hood, 0, 0.325, -1.60));
    // targeting computer arm (stowed up under the hood)
    M(xf(cbox(0.075, 0.045, 0.22, 0.012), 0.09, 0.345, -1.40));
    G(xf(bx(0.055, 0.030, 0.012), 0.09, 0.345, -1.29), 0.75);
    // control yoke
    M(xf(cyZ(0.020, 0.020, 0.24, 8), 0, 0.155, -1.18));
    M(xf(cyX(0.017, 0.017, 0.20, 8), 0, 0.262, -1.09));
    for (const sx of [-1, 1]) M(xf(sph(0.030, 8, 6), sx * 0.10, 0.262, -1.09));

    // ---- seat + pilot silhouette
    M(xf(cbox(0.30, 0.045, 0.34, 0.014), 0, 0.115, -0.78));
    const back = cbox(0.30, 0.42, 0.055, 0.016); back.rotateX(0.16);
    M(xf(back, 0, 0.325, -0.60));
    M(xf(cbox(0.34, 0.075, 0.075, 0.016), 0, 0.545, -0.585));
    for (const sx of [-1, 1]) M(xf(cbox(0.045, 0.30, 0.26, 0.012), sx * 0.165, 0.245, -0.74));
    // pilot: torso, shoulders, helmet
    M(xf(cbox(0.22, 0.30, 0.16, 0.05), 0, 0.290, -0.72));
    M(xf(cbox(0.30, 0.10, 0.14, 0.04), 0, 0.415, -0.72));
    const helm = sph(0.098, 12, 9); helm.scale(1.0, 1.05, 1.12);
    B.hull.push(norm(xf(helm, 0, 0.545, -0.76), 0, 0, 0));
    const vis = sph(0.094, 12, 9); vis.scale(0.99, 0.58, 1.02);
    G(xf(vis, 0, 0.528, -0.815));
    G(xf(cbox(0.075, 0.030, 0.070, 0.012), 0, 0.470, -0.845));            // chin guard
    const brow = cbox(0.155, 0.055, 0.030, 0.008); brow.rotateX(-0.22);
    G(xf(brow, 0, 0.560, -0.856));                                        // visor band
    for (const sx of [-1, 1]) G(xf(cbox(0.030, 0.075, 0.055, 0.010), sx * 0.092, 0.545, -0.780));
    M(xf(cbox(0.045, 0.020, 0.020, 0.005), 0.085, 0.505, -0.830), 0.55);  // comm light
    for (const sx of [-1, 1]) {
      const strap = cbox(0.045, 0.30, 0.020, 0.005); strap.rotateX(-0.16); strap.rotateZ(sx * 0.28);
      G(xf(strap, sx * 0.058, 0.315, -0.640));                            // harness
    }
    G(xf(cbox(0.10, 0.055, 0.045, 0.010), 0, 0.215, -0.660));             // buckle
    for (const sx of [-1, 1]) M(xf(cbox(0.055, 0.19, 0.075, 0.02), sx * 0.145, 0.315, -0.86));  // arms
    // headrest / rear bulkhead
    H(xf(cbox(0.40, 0.26, 0.055, 0.016), 0, 0.28, -0.40));
  } else {
    G(xf(bx(0.50, 0.02, 1.6), 0, TUB_FLOOR + 0.01, -0.85));
    G(xf(cbox(0.28, 0.42, 0.34, 0.05), 0, 0.30, -0.72));
  }

  // ---- canopy glass shell (5 facets across, faceted, double sided)
  B.glass.push(norm(sheet(cs), 0, 0, 0));

  // ---- canopy frame: real swept ribs, not a chain of rotated boxes
  if (!hero) return;
  const railPath = (p: number, dy: number) =>
    cs.map((sec) => new THREE.Vector3(sec.pts[p].x, sec.pts[p].y + dy, sec.z));
  for (const p of [0, 1, 2, 3, 4, 5]) {
    M(tubeAlong(railPath(p, 0.008), 0.030, 0.026));
  }
  // transverse hoops
  for (const i of [1, 3, 5, 7]) {
    const sec = cs[Math.min(i, cs.length - 1)];
    M(tubeAlong(sec.pts.map((v) => new THREE.Vector3(v.x, v.y + 0.008, sec.z)), 0.026, 0.024));
  }
  // sill rail sitting on the coaming
  for (const sgn of [-1, 1]) {
    M(tubeAlong(cs.map((sec) => new THREE.Vector3(sec.pts[sgn > 0 ? 5 : 0].x * 1.06, sec.pts[0].y - 0.012, sec.z)), 0.038, 0.030));
  }
  // rear hinge block + jack rams
  M(xf(cbox(0.30, 0.075, 0.12, 0.02), 0, keyAt(0.44).y + keyAt(0.44).h + 0.030, 0.46));
  for (const sgn of [-1, 1]) M(xf(cyX(0.020, 0.020, 0.09, 8), sgn * 0.155, keyAt(0.46).y + keyAt(0.46).h + 0.055, 0.46));
}

/* =========================================================================
   ASTROMECH — the dome carries aWing = 5 and spins in the vertex shader.
   ========================================================================= */

export const DOME_ORIGIN = new THREE.Vector3(0, 0, 0.95);

function buildAstromech(B: Bins, rng: RNG, hero: boolean) {
  const M = (g: THREE.BufferGeometry, e = 0, w = 0) => B.metal.push(norm(g, w, 0, e));
  const G = (g: THREE.BufferGeometry, e = 0, w = 0) => B.grille.push(norm(g, w, 0, e));
  const H = (g: THREE.BufferGeometry, e = 0, w = 0) => B.hull.push(norm(g, w, 0, e));
  const zc = DOME_ORIGIN.z;
  const k = keyAt(zc);
  const deck = k.y + k.h;
  DOME_ORIGIN.y = deck;

  // ---- socket rim + well cut into the spine
  M(xf(new THREE.CylinderGeometry(0.335, 0.350, 0.050, hero ? 24 : 12, 1, true), 0, deck - 0.018, zc));
  G(xf(new THREE.CylinderGeometry(0.310, 0.310, 0.34, hero ? 20 : 10, 1, true), 0, deck - 0.190, zc));
  G(xf(new THREE.CylinderGeometry(0.310, 0.310, 0.012, hero ? 20 : 10), 0, deck - 0.355, zc));
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.3;
    M(xf(cbox(0.055, 0.040, 0.055, 0.010), Math.cos(a) * 0.368, deck - 0.008, zc + Math.sin(a) * 0.368));
  }

  // ---- fixed lower body (blue/silver two-tone comes from the shader)
  H(xf(new THREE.CylinderGeometry(0.288, 0.278, 0.130, hero ? 24 : 10), 0, deck + 0.020, zc));
  if (hero) for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.2;
    G(xf(cbox(0.060, 0.080, 0.016, 0.004), Math.cos(a) * 0.286, deck + 0.020, zc + Math.sin(a) * 0.286));
  }

  // ---- rotating dome (aWing = 5)
  const W = 5;
  const dy = deck + 0.085;
  H(xf(new THREE.SphereGeometry(0.288, hero ? 24 : 10, hero ? 13 : 6, 0, Math.PI * 2, 0, Math.PI * 0.5), 0, dy, zc), 0, W);
  M(xf(new THREE.CylinderGeometry(0.290, 0.288, 0.028, hero ? 24 : 10), 0, dy - 0.012, zc), 0, W);
  // lens eye: dark glass housing + a hot pip
  G(xf(xf(sph(0.068, 12, 9), 0, 0, 0, 0, 0, 0, 1, 1, 0.55), 0, dy + 0.145, zc + 0.245), 0, W);
  M(xf(sph(0.017, 8, 6), 0, dy + 0.145, zc + 0.268), 0.95, W);
  M(xf(cyZ(0.070, 0.076, 0.02, 14), 0, dy + 0.145, zc + 0.246), 0, W);
  if (hero) {
    // radial panel detail + holo projectors
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.15;
      const el = 0.30 + (i % 2) * 0.34;
      const r = 0.290;
      const cx = Math.cos(a) * Math.cos(el) * r, cz = Math.sin(a) * Math.cos(el) * r, cy = Math.sin(el) * r;
      const p = cbox(0.085, 0.070, 0.012, 0.004);
      p.rotateX(el); p.rotateY(Math.PI / 2 - a);
      M(xf(p, cx, dy + cy, zc + cz), 0, W);
    }
    for (const s of [-1, 1]) M(xf(cyZ(0.014, 0.014, 0.085, 8), s * 0.145, dy + 0.225, zc + 0.185), 0, W);
    G(xf(cbox(0.11, 0.075, 0.012, 0.004), 0, dy + 0.115, zc - 0.268), 0, W);
  }
}

/* =========================================================================
   AFT FUSELAGE / TORPEDO TUBES / GREEBLE FIELD
   ========================================================================= */

function buildAft(B: Bins, rng: RNG, hero: boolean) {
  const H = (g: THREE.BufferGeometry, e = 0) => B.hull.push(norm(g, 0, 0, e));
  const M = (g: THREE.BufferGeometry, e = 0) => B.metal.push(norm(g, 0, 0, e));
  const G = (g: THREE.BufferGeometry, e = 0) => B.grille.push(norm(g, 0, 0, e));

  // ---- raised aft spine
  if (hero) for (let i = 0; i < 5; i++) {
    const z = 1.10 + i * 0.72;
    const k = keyAt(z);
    H(xf(cbox(k.w * (0.60 - i * 0.02), 0.032, 0.58, 0.014), 0, k.y + k.h * 0.985, z));
  }
  // ---- dorsal + ventral stabiliser fins at the wing root
  for (const sy of [1, -1]) {
    const sec: { z: number; pts: THREE.Vector2[] }[] = [];
    for (let i = 0; i <= 5; i++) {
      const t = i / 5;
      const z = 2.35 + t * 2.35;
      const k = keyAt(z);
      const base = sy > 0 ? k.y + k.h * 0.97 : k.y - k.h * 0.97;
      const hgt = (0.10 + 0.34 * Math.sin(Math.PI * Math.min(1, t * 1.25))) * sy;
      const th = 0.055 * (1 - t * 0.45);
      const pts = [
        new THREE.Vector2(-th, base), new THREE.Vector2(-th * 0.35, base + hgt),
        new THREE.Vector2(th * 0.35, base + hgt), new THREE.Vector2(th, base),
      ];
      if (sy < 0) pts.reverse();
      sec.push({ z, pts });
    }
    H(loftCreased(sec, [true, true, true, true], true, true));
  }

  // ---- aft deck plating + coolant runs so the tail is not a bare blob
  if (hero) for (const mirror of [false, true]) {
    const PP2 = RING.length;
    for (let i = 0; i < 5; i++) {
      const z = 1.55 + i * 0.72;
      const a = hullSurface(z, mirror ? PP2 - 5 : 5);
      const b = hullSurface(z + 0.30, mirror ? PP2 - 11 : 11);
      const ra = Math.atan2(a.ny, a.nx) - Math.PI / 2;
      const rb = Math.atan2(b.ny, b.nx) - Math.PI / 2;
      H(xf(cbox(0.13, 0.030, 0.58, 0.010), a.x, a.y, z, 0, 0, ra));
      M(xf(cyZ(0.020, 0.020, 0.66, 7), a.x + a.nx * 0.030, a.y + a.ny * 0.030, z, 0, 0, ra));
      G(xf(cbox(0.10, 0.016, 0.24, 0.006), b.x, b.y, z + 0.30, 0, 0, rb));
      if (i % 2 === 0) M(xf(cbox(0.055, 0.055, 0.055, 0.010), a.x + a.nx * 0.030, a.y + a.ny * 0.030, z + 0.30, 0, 0, ra));
    }
  }

  // ---- torpedo tubes, low on the flanks forward of the wings
  for (const sx of [-1, 1]) {
    M(xf(cbox(0.20, 0.165, 1.05, 0.030), sx * 0.605, -0.145, -2.45));
    G(xf(cbox(0.135, 0.105, 0.34, 0.012), sx * 0.605, -0.145, -2.90));
    G(xf(cyZ(0.052, 0.058, 0.10, 12), sx * 0.605, -0.145, -2.955), 0.15);
    M(xf(cbox(0.055, 0.050, 0.30, 0.012), sx * 0.700, -0.145, -2.30));
    // blast-shield lip
    H(xf(cbox(0.235, 0.045, 0.10, 0.014), sx * 0.605, -0.055, -2.94));
    H(xf(cbox(0.235, 0.045, 0.10, 0.014), sx * 0.605, -0.235, -2.94));
  }

  // ---- landing-gear bay doors (closed) + tow-cable fairleads + hatches
  if (!hero) return;
  for (const sx of [-1, 1]) {
    const k = keyAt(1.75);
    G(xf(cbox(0.30, 0.020, 0.85, 0.010), sx * 0.28, k.y - k.h * 0.985, 1.75));
    H(xf(cbox(0.32, 0.014, 0.88, 0.010), sx * 0.28, k.y - k.h * 0.995, 1.75));
    M(xf(cyX(0.030, 0.030, 0.10, 8), sx * 0.42, k.y - k.h * 0.94, 1.35));
  }
  // long raised flank strakes that break up the mid-fuselage
  const P = RING.length;
  if (hero) for (const mirror of [false, true]) {
    for (let i = 0; i < 6; i++) {
      const z = -5.10 + i * 1.32;
      const i1 = mirror ? P - 6 : 6, i2 = mirror ? P - 9 : 9;
      const a = hullSurface(z, i1), b = hullSurface(z + 0.35, i2);
      const ra = Math.atan2(a.ny, a.nx) - Math.PI / 2;
      const rb = Math.atan2(b.ny, b.nx) - Math.PI / 2;
      H(xf(cbox(0.030, 0.070, 1.05, 0.010), a.x, a.y, z, 0, 0, ra));
      H(xf(cbox(0.026, 0.050, 0.82, 0.008), b.x, b.y, z + 0.35, 0, 0, rb));
      if (i % 2 === 1) M(xf(cbox(0.042, 0.095, 0.16, 0.010), a.x, a.y, z + 0.42, 0, 0, ra));
    }
  }
  const kn = keyAt(-3.30);
  G(xf(cbox(0.24, 0.018, 0.62, 0.010), 0, kn.y - kn.h * 0.985, -3.30));
  H(xf(cbox(0.26, 0.012, 0.65, 0.010), 0, kn.y - kn.h * 0.995, -3.30));
}

/** Seeded greeble field: >=60 distinct placements across the fuselage. */
function buildGreebles(B: Bins, rng: RNG, hero: boolean): number {
  const H = (g: THREE.BufferGeometry, e = 0) => B.hull.push(norm(g, 0, 0, e));
  const M = (g: THREE.BufferGeometry, e = 0) => B.metal.push(norm(g, 0, 0, e));
  const G = (g: THREE.BufferGeometry, e = 0) => B.grille.push(norm(g, 0, 0, e));
  let n = 0;
  const count = hero ? 112 : 16;

  for (let i = 0; i < count; i++) {
    const z = rng.range(-6.4, 4.7);
    if (z > COCKPIT_Z0 - 0.25 && z < COCKPIT_Z1 + 0.6 && rng.bool(0.8)) continue;  // keep the tub clear
    // pick a ring vertex, then seat the part on the real surface with the real normal
    const P = RING.length;
    const face = rng.next();
    let idx: number;
    if (face < 0.50) idx = rng.int(5, 9);              // flanks (starboard)
    else if (face < 0.76) idx = rng.int(10, 13);        // chisel underside
    else idx = rng.int(1, 4);                           // spine
    if (rng.bool()) idx = (P - idx) % P;                // mirror to the port side
    const sp = hullSurface(z, idx);
    const px = sp.x, py = sp.y;
    const rx = 0, ry = 0;
    const rz = Math.atan2(sp.ny, sp.nx) - Math.PI / 2;
    const kind = rng.next();
    const s = rng.range(0.65, 1.4);
    if (kind < 0.24) {
      const g = cbox(rng.range(0.06, 0.18) * s, rng.range(0.02, 0.06) * s, rng.range(0.10, 0.34) * s, 0.008);
      H(xf(g, px, py, z, rx, ry, rz));
    } else if (kind < 0.42) {
      const g = cbox(rng.range(0.05, 0.12) * s, rng.range(0.03, 0.09) * s, rng.range(0.05, 0.14) * s, 0.010);
      M(xf(g, px, py, z, rx, ry, rz));
    } else if (kind < 0.56) {                // recessed vent with slats
      const w = rng.range(0.09, 0.20) * s, d = rng.range(0.10, 0.24) * s;
      G(xf(cbox(w, 0.014, d, 0.005), px, py, z, rx, ry, rz));
      const slats = rng.int(3, 5);
      for (let j = 0; j < slats; j++) {
        M(xf(cbox(w * 0.86, 0.022, d / slats * 0.42, 0.004), px + sp.nx * 0.008, py + sp.ny * 0.008, z + (j / slats - 0.45) * d, rx, ry, rz));
      }
      n += slats;
    } else if (kind < 0.70) {                // pipe run with collars
      const len = rng.range(0.30, 0.95);
      const r = rng.range(0.015, 0.032);
      M(xf(cyZ(r, r, len, 7), px, py, z, rx, ry, rz));
      for (let j = 0; j < 3; j++) M(xf(cyZ(r * 1.7, r * 1.7, r * 1.2, 7), px, py, z + (j - 1) * len * 0.36, rx, ry, rz));
      n += 3;
    } else if (kind < 0.80) {                // sensor blister
      const b = sph(rng.range(0.030, 0.062) * s, 10, 7);
      b.scale(1, 0.62, rng.range(0.9, 1.8));
      H(xf(b, px, py, z, rx, ry, rz));
    } else if (kind < 0.88) {                // bolted hardpoint
      const r = rng.range(0.030, 0.055) * s;
      const disc = cyZ(r, r * 0.8, 0.030, 9); disc.rotateX(Math.PI / 2); disc.rotateZ(rz);
      M(xf(disc, px, py, z));
      for (let j = 0; j < 5; j++) {
        const a = (j / 5) * Math.PI * 2;
        M(xf(cbox(0.012, 0.014, 0.012, 0.003),
          px + sp.nx * 0.012 + (-sp.ny) * Math.cos(a) * r * 0.72,
          py + sp.ny * 0.012 + (sp.nx) * Math.cos(a) * r * 0.72,
          z + Math.sin(a) * r * 0.72));
      }
      n += 5;
    } else if (kind < 0.95) {                // access hatch with a raised lip
      const w = rng.range(0.10, 0.22) * s, d = rng.range(0.12, 0.26) * s;
      H(xf(cbox(w, 0.016, d, 0.006), px, py, z, rx, ry, rz));
      G(xf(cbox(w * 0.72, 0.020, d * 0.72, 0.005), px, py, z, rx, ry, rz));
      n++;
    } else {                                 // warning strip / nav light
      M(xf(cbox(rng.range(0.05, 0.12), 0.014, 0.035, 0.004), px, py, z, rx, ry, rz), rng.bool(0.5) ? 0.42 : 0.20);
    }
    n++;
  }
  return n;
}

/* =========================================================================
   WING ASSEMBLY — built once for the (+x,+y) quadrant, then mirrored.
   ========================================================================= */

const WING_Y = 0.60;
const WING_X0 = 0.72, WING_X1 = 5.72;
const ENG_X = 0.95, ENG_R = 0.395, ENG_Z0 = 2.28, ENG_Z1 = 5.18;
const CAN_X = 5.58, CAN_MUZZLE_Z = -0.68;

const CS = [0, 0.02, 0.06, 0.13, 0.25, 0.40, 0.58, 0.76, 0.90, 1.0];

const CS_LOW = [0, 0.10, 0.35, 0.70, 1.0];

function wingPlank(hero: boolean): THREE.BufferGeometry {
  const CH = hero ? CS : CS_LOW;
  const N = hero ? 13 : 3;
  const sections: { z: number; pts: THREE.Vector2[] }[] = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const x = WING_X0 + (WING_X1 - WING_X0) * t;
    const le = 1.72 + 0.40 * t, te = 4.44 - 0.26 * t;
    const th = 0.118 - 0.060 * t;
    const halfT = (c: number) => th * (airfoilT(c) / 0.5 * 0.88 + 0.12 * c * c);
    const pts: THREE.Vector2[] = [];
    for (let j = 0; j < CH.length; j++) {
      const c = CH[j];
      pts.push(new THREE.Vector2(-(le + c * (te - le)), -halfT(c)));
    }
    for (let j = CH.length - 1; j >= 1; j--) {
      const c = CH[j];
      pts.push(new THREE.Vector2(-(le + c * (te - le)), halfT(c)));
    }
    sections.push({ z: x, pts });
  }
  const creases = sections[0].pts.map((_, i) => !LOW && (i === CH.length - 1 || i === CH.length));
  const g = loftCreased(sections, creases, true, true);
  g.rotateY(Math.PI / 2);
  g.translate(0, WING_Y, 0);
  return g;
}

function buildWingQuadrant(rng: RNG, hero: boolean): { hull: THREE.BufferGeometry[]; metal: THREE.BufferGeometry[]; grille: THREE.BufferGeometry[] } {
  const hull: THREE.BufferGeometry[] = [], metal: THREE.BufferGeometry[] = [], grille: THREE.BufferGeometry[] = [];
  const H = (g: THREE.BufferGeometry, e = 0, sl = 0) => hull.push(norm(g, 1, sl, e));
  const M = (g: THREE.BufferGeometry, e = 0, sl = 0) => metal.push(norm(g, 1, sl, e));
  const G = (g: THREE.BufferGeometry, e = 0, sl = 0) => grille.push(norm(g, 1, sl, e));

  /* ---- the plank ------------------------------------------------------- */
  H(wingPlank(hero));

  // raised strakes on both surfaces + a spanwise spar cap
  if (hero) for (const sy of [1, -1]) {
    for (const zc of [2.35, 3.30]) {
      H(xf(cbox(WING_X1 - WING_X0 - 0.55, 0.020, 0.16, 0.008),
        (WING_X0 + WING_X1) / 2 + 0.15, WING_Y + sy * 0.088, zc));
    }
    M(xf(cbox(0.85, 0.024, 0.44, 0.010), 1.75, WING_Y + sy * 0.090, 2.75));
  }
  // trailing flap / aileron slots
  if (hero) for (let i = 0; i < 3; i++) {
    const x0 = 2.30 + i * 1.02;
    const t = (x0 - WING_X0) / (WING_X1 - WING_X0);
    const te = 4.44 - 0.26 * t;
    G(xf(cbox(0.92, 0.036, 0.045, 0.006), x0, WING_Y, te - 0.30));
    H(xf(cbox(0.90, 0.048, 0.30, 0.010), x0, WING_Y, te - 0.14));
    for (const s of [-1, 1]) M(xf(cbox(0.035, 0.055, 0.11, 0.008), x0 + s * 0.44, WING_Y, te - 0.30));
  }
  // wingtip nav light + tip fence
  H(xf(cbox(0.06, 0.075, 0.75, 0.012), WING_X1 - 0.03, WING_Y, 3.30));
  M(xf(cbox(0.045, 0.045, 0.10, 0.010), WING_X1 + 0.005, WING_Y + 0.055, 3.85), 0.9);

  /* ---- engine nacelle --------------------------------------------------- */
  const seg = hero ? 20 : 9;
  const EY = WING_Y;
  // intake lip + recessed grille
  M(xf(cyZ(0.375, ENG_R + 0.030, 0.14, seg), ENG_X, EY, ENG_Z0 + 0.07));
  G(xf(cyZ(0.360, 0.360, 0.30, seg, true), ENG_X, EY, ENG_Z0 + 0.28));
  G(xf(cyZ(0.360, 0.360, 0.014, seg), ENG_X, EY, ENG_Z0 + 0.42));
  if (hero) {
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI;
      const f = cbox(0.70, 0.030, 0.10, 0.006); f.rotateZ(a);
      M(xf(f, ENG_X, EY, ENG_Z0 + 0.20));
    }
    M(xf(cyZ(0.075, 0.055, 0.30, 10), ENG_X, EY, ENG_Z0 + 0.24));
  }
  // forward body
  H(xf(cyZ(ENG_R, ENG_R + 0.012, 1.05, seg), ENG_X, EY, ENG_Z0 + 0.70));
  // cooling fin band
  const fins = hero ? 14 : 0;
  for (let i = 0; i < fins; i++) {
    const a = (i / fins) * Math.PI * 2;
    const f = cbox(0.055, 0.11, 0.62, 0.010);
    f.rotateZ(a);
    M(xf(f, ENG_X + Math.cos(a) * (ENG_R + 0.045), EY + Math.sin(a) * (ENG_R + 0.045), ENG_Z0 + 1.55));
  }
  M(xf(cyZ(ENG_R + 0.020, ENG_R + 0.020, 0.055, seg), ENG_X, EY, ENG_Z0 + 1.24));
  M(xf(cyZ(ENG_R + 0.020, ENG_R + 0.020, 0.055, seg), ENG_X, EY, ENG_Z0 + 1.86));
  // aft body
  H(xf(cyZ(ENG_R + 0.012, ENG_R + 0.045, 0.75, seg), ENG_X, EY, ENG_Z0 + 2.28));
  // exhaust bell: a shallow flare with a recessed, ring-baffled throat
  M(xf(cyZ(ENG_R + 0.012, ENG_R + 0.055, 0.42, seg, true), ENG_X, EY, ENG_Z1 - 0.21));
  M(xf(cyZ(ENG_R + 0.055, ENG_R + 0.042, 0.045, seg), ENG_X, EY, ENG_Z1 - 0.008));
  // deep, narrow throat: from this close a shallow cone just reads as a lid
  G(xf(cyZ(0.105, ENG_R + 0.005, 0.58, seg, true), ENG_X, EY, ENG_Z1 - 0.31));
  G(xf(cyZ(0.105, 0.105, 0.02, seg), ENG_X, EY, ENG_Z1 - 0.60));
  M(xf(cyZ(ENG_R + 0.005, ENG_R + 0.030, 0.035, seg), ENG_X, EY, ENG_Z1 - 0.028));
  // ring baffles + the hot centre cone keep the throat from reading as a hole
  if (hero) {
    M(xf(cyZ(0.320, 0.345, 0.030, seg), ENG_X, EY, ENG_Z1 - 0.12), 0.26);
    M(xf(cyZ(0.230, 0.255, 0.028, seg), ENG_X, EY, ENG_Z1 - 0.28), 0.32);
    M(xf(cyZ(0.155, 0.175, 0.026, seg), ENG_X, EY, ENG_Z1 - 0.44), 0.38);
  }
  M(xf(cyZ(0.026, 0.135, 0.40, hero ? 14 : 8), ENG_X, EY, ENG_Z1 - 0.34), 0.40);
  if (hero) for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.4;
    const f = cbox(0.022, 0.130, 0.34, 0.005); f.rotateZ(a);
    M(xf(f, ENG_X + Math.cos(a) * 0.275, EY + Math.sin(a) * 0.275, ENG_Z1 - 0.26), 0.18);
  }

  // nacelle plumbing / greebles
  const gr = rng.fork(7);
  for (let i = 0; i < (hero ? 16 : 3); i++) {
    const a = gr.range(0, Math.PI * 2);
    const z = gr.range(ENG_Z0 + 0.55, ENG_Z1 - 0.45);
    const r = ENG_R + 0.018;
    const px = ENG_X + Math.cos(a) * r, py = EY + Math.sin(a) * r;
    const kind = gr.next();
    if (kind < 0.4) {
      const g = cbox(gr.range(0.05, 0.11), gr.range(0.03, 0.07), gr.range(0.12, 0.34), 0.008);
      g.rotateZ(a); M(xf(g, px, py, z));
    } else if (kind < 0.72) {
      const len = gr.range(0.5, 1.3), rr = gr.range(0.016, 0.032);
      M(xf(cyZ(rr, rr, len, 7), px, py, z));
      for (let j = 0; j < 3; j++) M(xf(cyZ(rr * 1.8, rr * 1.8, rr, 7), px, py, z + (j - 1) * len * 0.35));
    } else {
      const g = cbox(gr.range(0.06, 0.14), 0.018, gr.range(0.08, 0.20), 0.005);
      g.rotateZ(a); G(xf(g, px, py, z), gr.bool(0.3) ? 0.35 : 0);
    }
  }
  // root fairing that blends the nacelle into the hull
  H(xf(cbox(0.42, 0.30, 1.85, 0.060), ENG_X - 0.36, EY - 0.16, 3.35));

  /* ---- wingtip laser cannon --------------------------------------------- */
  const cz = (a: number, b: number, len: number, s = 12, open = false) => cyZ(a, b, len, s, open);
  M(xf(cz(0.052, 0.046, 3.05, hero ? 14 : 8), CAN_X, WING_Y, CAN_MUZZLE_Z + 1.83));
  // flared muzzle
  M(xf(cz(0.108, 0.058, 0.32, hero ? 16 : 8), CAN_X, WING_Y, CAN_MUZZLE_Z + 0.16));
  G(xf(cz(0.062, 0.062, 0.16, hero ? 14 : 8, true), CAN_X, WING_Y, CAN_MUZZLE_Z + 0.10), 0.12);
  G(xf(cz(0.048, 0.048, 0.012, 10), CAN_X, WING_Y, CAN_MUZZLE_Z + 0.19), 0.55);
  // three collars, bolted
  for (let i = 0; i < (hero ? 3 : 1); i++) {
    const z = CAN_MUZZLE_Z + 0.62 + i * 0.86;
    M(xf(cz(0.084, 0.084, 0.10, hero ? 14 : 8), CAN_X, WING_Y, z));
    M(xf(cz(0.094, 0.078, 0.045, hero ? 14 : 8), CAN_X, WING_Y, z - 0.07));
    if (hero) for (let j = 0; j < 6; j++) {
      const a = (j / 6) * Math.PI * 2 + i;
      M(xf(cbox(0.016, 0.016, 0.016, 0.004), CAN_X + Math.cos(a) * 0.086, WING_Y + Math.sin(a) * 0.086, z));
    }
  }
  // gun body + mounting pylon into the wingtip
  H(xf(cbox(0.165, 0.170, 1.00, 0.030), CAN_X, WING_Y, CAN_MUZZLE_Z + 3.42));
  M(xf(cbox(0.100, 0.115, 0.30, 0.018), CAN_X, WING_Y, CAN_MUZZLE_Z + 4.05));
  M(xf(cz(0.055, 0.028, 0.26, 10), CAN_X, WING_Y, CAN_MUZZLE_Z + 4.32));
  H(xf(cbox(0.135, 0.100, 0.78, 0.024), CAN_X - 0.10, WING_Y, CAN_MUZZLE_Z + 2.62));
  // coolant lines down the barrel
  if (hero) for (const s of [-1, 1]) {
    M(xf(cz(0.014, 0.014, 2.35, 6), CAN_X + s * 0.070, WING_Y - 0.052, CAN_MUZZLE_Z + 1.70));
    for (let j = 0; j < 4; j++) M(xf(cbox(0.020, 0.030, 0.024, 0.005), CAN_X + s * 0.070, WING_Y - 0.052, CAN_MUZZLE_Z + 0.75 + j * 0.62));
  }
  G(xf(cbox(0.06, 0.05, 0.20, 0.010), CAN_X, WING_Y + 0.10, CAN_MUZZLE_Z + 3.30), 0.35);

  /* ---- s-foil hinge + actuator ------------------------------------------ */
  const PX = WING_PIVOT[0][0], PY = WING_PIVOT[0][1];
  // wing-side hinge lug + spar stub reaching in to the hinge
  M(xf(cbox(0.115, 0.235, 0.36, 0.022), PX, PY, WING_HINGE_Z));
  H(xf(cbox(0.155, 0.30, 0.90, 0.035), PX + 0.02, PY + 0.11, WING_HINGE_Z + 0.05));
  H(xf(cbox(0.20, 0.42, 0.70, 0.055), PX + 0.14, (PY + WING_Y) * 0.5 + 0.06, 3.30));
  // actuator: fat housing on the fuselage side, chrome rod that extends
  const ANG = 0.235;
  const cyl = (r: number, len: number, s = 10) => { const g = cyX(r, r, len, s); g.rotateZ(ANG); return g; };
  M(xf(cyl(0.034, 0.86, 10), 0.80, 0.32, 3.70), 0, 1);       // sliding chrome rod
  M(xf(cbox(0.075, 0.085, 0.085, 0.014), 1.19, 0.415, 3.70), 0, 1);   // rod-end clevis
  if (hero) {
    M(xf(cbox(0.085, 0.10, 0.10, 0.016), 1.30, 0.455, 3.70));         // nacelle bracket
    M(xf(cyZ(0.020, 0.020, 0.14, 8), 1.245, 0.435, 3.70));            // clevis pin
  }
  // flexible hoses running out along the root
  if (hero) for (let i = 0; i < 3; i++) {
    const yy = 0.24 + i * 0.09;
    M(xf(cyl(0.013 + i * 0.003, 0.70, 6), 0.92, yy, 3.30 + i * 0.16));
  }
  return { hull, metal, grille };
}

/** Fuselage-side hinge hardware (static, aWing = 0). */
function buildHingeStatic(B: Bins, hero: boolean) {
  const M = (g: THREE.BufferGeometry, e = 0) => B.metal.push(norm(g, 0, 0, e));
  const H = (g: THREE.BufferGeometry, e = 0) => B.hull.push(norm(g, 0, 0, e));
  const ANG = 0.235;
  for (let i = 0; i < 4; i++) {
    const sx = WING_SX[i], sy = WING_SY[i];
    const PX = WING_PIVOT[i][0], PY = WING_PIVOT[i][1];
    if (hero) {
      // clevis cheeks either side of the wing lug
      for (const dz of [-0.235, 0.235]) {
        M(xf(cbox(0.135, 0.26, 0.10, 0.020), PX, PY, WING_HINGE_Z + dz));
      }
      M(xf(cyZ(0.062, 0.062, 0.05, 12), PX, PY, WING_HINGE_Z - 0.36));
      M(xf(cyZ(0.062, 0.062, 0.05, 12), PX, PY, WING_HINGE_Z + 0.36));
    }
    M(xf(cyZ(0.048, 0.048, 0.72, hero ? 12 : 6), PX, PY, WING_HINGE_Z));
    // root fairing on the hull
    H(xf(cbox(0.24, 0.34, 1.10, 0.055), PX - sx * 0.10, PY - sy * 0.02, WING_HINGE_Z - 0.10));
    // actuator housing, anchored to the fuselage
    const g = cyX(0.062, 0.062, 0.62, hero ? 12 : 6); g.rotateZ(ANG * sx * sy);
    M(xf(g, sx * 0.60, sy * 0.245, 3.70));
    if (hero) M(xf(cbox(0.11, 0.13, 0.13, 0.022), sx * 0.36, sy * 0.19, 3.70));
    if (hero) {
      M(xf(cyZ(0.020, 0.020, 0.34, 7), sx * 0.62, sy * 0.30, 3.70));
      M(xf(cbox(0.05, 0.05, 0.05, 0.010), sx * 0.62, sy * 0.30, 3.88));
    }
  }
}

/* =========================================================================
   TOP-LEVEL BUILD
   ========================================================================= */

export interface XWingBuild {
  hull: THREE.BufferGeometry;
  metal: THREE.BufferGeometry;
  grille: THREE.BufferGeometry;
  glass: THREE.BufferGeometry;
  engines: EngineDesc[];
  /** local (s-foils closed) muzzle / bell / tube points; wing parts get rotated on the CPU */
  cannonLocal: THREE.Vector3[];
  engineLocal: THREE.Vector3[];
  torpedoLocal: THREE.Vector3[];
  greebleCount: number;
  tris: number;
}

export function buildXWingGeometry(seed: number, hero: boolean): XWingBuild {
  LOW = !hero;
  const rng = new RNG(seed);
  const B: Bins = { hull: [], metal: [], grille: [], glass: [] };

  B.hull.push(norm(fuselageGeometry(), 0, 0, 0));
  buildNose(B, rng.fork(1), hero);
  buildCockpit(B, rng.fork(2), hero);
  buildAstromech(B, rng.fork(3), hero);
  buildAft(B, rng.fork(4), hero);
  const greebleCount = buildGreebles(B, rng.fork(5), hero);
  buildHingeStatic(B, hero);

  // ---- one wing quadrant, mirrored into four
  const q = buildWingQuadrant(rng.fork(6), hero);
  const qh = mergeAll(q.hull), qm = mergeAll(q.metal), qg = mergeAll(q.grille);
  for (let i = 0; i < 4; i++) {
    const sx = WING_SX[i], sy = WING_SY[i];
    B.hull.push(mirrorGeo(qh, sx, sy, i + 1, sx));
    B.metal.push(mirrorGeo(qm, sx, sy, i + 1, sx));
    B.grille.push(mirrorGeo(qg, sx, sy, i + 1, sx));
  }
  qh.dispose(); qm.dispose(); qg.dispose();

  const hull = mergeAll(B.hull);
  const metal = mergeAll(B.metal);
  const grille = mergeAll(B.grille);
  const glass = mergeAll(B.glass);

  const bs = new THREE.Sphere(new THREE.Vector3(0, 0, -0.6), 8.2);
  for (const g of [hull, metal, grille, glass]) g.boundingSphere = bs.clone();

  const engines: EngineDesc[] = [];
  const cannonLocal: THREE.Vector3[] = [];
  const engineLocal: THREE.Vector3[] = [];
  for (let i = 0; i < 4; i++) {
    const sx = WING_SX[i], sy = WING_SY[i];
    engines.push({ wing: i + 1, x: sx * ENG_X, y: sy * WING_Y, z: ENG_Z1, r: ENG_R });
    engineLocal.push(new THREE.Vector3(sx * ENG_X, sy * WING_Y, ENG_Z1));
    cannonLocal.push(new THREE.Vector3(sx * CAN_X, sy * WING_Y, CAN_MUZZLE_Z));
  }
  const torpedoLocal = [
    new THREE.Vector3(-0.605, -0.145, -3.00),
    new THREE.Vector3(0.605, -0.145, -3.00),
  ];

  const tris = triCount(hull) + triCount(metal) + triCount(grille) + triCount(glass);
  LOW = false;
  return { hull, metal, grille, glass, engines, cannonLocal, engineLocal, torpedoLocal, greebleCount, tris };
}
