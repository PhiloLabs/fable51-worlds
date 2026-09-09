import * as THREE from 'three';
import { RNG, hash1 } from '../core/rng';
import { clamp, lerp, smoothstep } from '../core/mathx';
import {
  MERIDIAN_CORRIDOR_S0, MERIDIAN_CORRIDOR_S1,
  PORT_RADIUS, PORT_S,
  TRENCH_DEPTH, TRENCH_HALF_WIDTH,
  trenchQuat, trenchRadial, trenchToWorld,
} from '../core/constants';
import { createHullMaterial, updateHullMaterials } from './hullMaterial';
import * as TP from './trenchProps';

/* =========================================================================
   THE TRENCH
   A ~30 km streamed, procedurally composed canyon in the Death Star surface.
   Everything is authored in world space and pushed into InstancedMesh pools
   that are parented to `group`; `group` is expected to sit at the origin
   with an identity transform (the geometry already carries world placement).
   ========================================================================= */

export interface TrenchTurret {
  root: THREE.Object3D;
  head: THREE.Object3D;
  barrels: THREE.Object3D;
  muzzle: THREE.Vector3;
  s: number; lateral: number; up: number;
  side: -1 | 0 | 1;
  alive: boolean;
  cooldown: number;
  destroy(): void;
}

export interface Trench {
  group: THREE.Group;
  turrets: TrenchTurret[];
  materials: THREE.Material[];
  update(dt: number, time: number, playerS: number, camera: THREE.Camera): void;
  collide(s: number, lateral: number, up: number, radius: number): { lateral: number; up: number; hit: boolean; normal: THREE.Vector3 };
  port: THREE.Object3D;
  portMouth: THREE.Vector3;
  setDamage(v: number): void;
  dispose(): void;
}

/* ----------------------------------------------------------- tuning knobs */

const SEG = TP.SEG_LEN;                     // 250 m
const WIN_BACK = 2500;
const WIN_FWD = 11000;
const SEG_MIN = Math.floor(MERIDIAN_CORRIDOR_S0 / SEG);
const SEG_MAX = Math.floor(MERIDIAN_CORRIDOR_S1 / SEG) - 1;
const PORT_HOLE_R = 19;
const APPROACH_S0 = 21600;                  // "you are nearly there" styling begins
const MAX_ANIM = 24;

/* --------------------------------------------------------- shape of the run */

/** always-positive modulo */
function imod(a: number, n: number) { return ((a % n) + n) % n; }

/** smooth 1-D value noise, [-1,1] */
function n1(x: number): number {
  const i = Math.floor(x), f = x - i;
  const u = f * f * (3 - 2 * f);
  return (hash1(i) * (1 - u) + hash1(i + 1) * u) * 2 - 1;
}
function n1b(x: number): number { return n1(x) * 0.68 + n1(x * 2.17 + 5.5) * 0.32; }

const PORT_FLAT_IN = 420, PORT_FLAT_OUT = 1700;
function portFade(s: number) {
  return clamp((Math.abs(s - PORT_S) - PORT_FLAT_IN) / (PORT_FLAT_OUT - PORT_FLAT_IN), 0, 1);
}

const RAW_HW = (s: number) => TRENCH_HALF_WIDTH + 6 * n1b(s / 900 + 11.3);
const RAW_FL = (s: number) => -TRENCH_DEPTH + 8 * n1b(s / 1300 + 4.7);

/** trench half-width at arc-length s */
export function halfWidthAt(s: number): number {
  return lerp(RAW_HW(PORT_S), RAW_HW(s), portFade(s));
}
/** trench floor height (up) at arc-length s */
export function floorAt(s: number): number {
  return lerp(RAW_FL(PORT_S), RAW_FL(s), portFade(s));
}
/** lateral drift of the trench centreline at arc-length s */
export function centreAt(s: number): number {
  return 10 * n1b(s / 1700 + 21.1) * portFade(s);
}
const D = 4;
const dHalfWidth = (s: number) => (halfWidthAt(s + D) - halfWidthAt(s - D)) / (2 * D);
const dFloor = (s: number) => (floorAt(s + D) - floorAt(s - D)) / (2 * D);
const dCentre = (s: number) => (centreAt(s + D) - centreAt(s - D)) / (2 * D);

/* ---------------------------------------------------------- matrix helpers */

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _sc = new THREE.Vector3();
const _eu = new THREE.Euler();
const _mScratch = new THREE.Matrix4();
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

/** compose a world matrix for something authored in the trench-segment frame */
function lmat(s: number, lateral: number, up: number,
  ex = 0, ey = 0, ez = 0, sx = 1, sy = 1, sz = 1, out = _mScratch): THREE.Matrix4 {
  trenchToWorld(s, lateral, up, _p);
  trenchQuat(s, _q);
  if (ex || ey || ez) { _eu.set(ex, ey, ez, 'YXZ'); _q.multiply(_q2.setFromEuler(_eu)); }
  _sc.set(sx, sy, sz);
  return out.compose(_p, _q, _sc);
}

/* --------------------------------------------------------------- inst pool */

class InstPool {
  mesh: THREE.InstancedMesh;
  private free: number[] = [];
  /** high-water mark — instances above this are never drawn */
  private hi = 0;
  dirty = false;
  constructor(geo: THREE.BufferGeometry, mat: THREE.Material, public cap: number, name: string) {
    this.mesh = new THREE.InstancedMesh(geo, mat, cap);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = cap - 1; i >= 0; i--) { this.mesh.setMatrixAt(i, ZERO); this.free.push(i); }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
  alloc(m: THREE.Matrix4): number {
    const i = this.free.pop();
    if (i === undefined) return -1;
    this.mesh.setMatrixAt(i, m);
    if (i + 1 > this.hi) { this.hi = i + 1; this.mesh.count = this.hi; }
    this.dirty = true;
    return i;
  }
  set(i: number, m: THREE.Matrix4) { this.mesh.setMatrixAt(i, m); this.dirty = true; }
  release(i: number) {
    this.mesh.setMatrixAt(i, ZERO);
    this.free.push(i);
    this.dirty = true;
  }
  flush() { if (this.dirty) { this.mesh.instanceMatrix.needsUpdate = true; this.dirty = false; } }
  get used() { return this.cap - this.free.length; }
}

/** instanced pool that also carries a per-instance parameter vec3 */
class ParamPool extends InstPool {
  params: THREE.InstancedBufferAttribute;
  constructor(geo: THREE.BufferGeometry, mat: THREE.Material, cap: number, name: string) {
    const g = geo.clone();
    const arr = new Float32Array(cap * 3);
    const attr = new THREE.InstancedBufferAttribute(arr, 3);
    attr.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aParams', attr);
    super(g, mat, cap, name);
    this.params = attr;
  }
  setParams(i: number, a: number, b: number, c: number) {
    this.params.setXYZ(i, a, b, c);
    this.params.needsUpdate = true;
  }
}

/* ---------------------------------------------------------------- shaders */

const ADD_VERT = /* glsl */`
#include <common>
attribute vec3 aParams;
varying vec2 vU;
varying vec3 vPar;
void main() {
  vU = uv;
  vPar = aParams;
  #include <begin_vertex>
  #include <project_vertex>
}
`;

function stripMaterial(): THREE.ShaderMaterial {
  const uniforms = {
    uTime: { value: 0 }, uDamage: { value: 0 },
    uColA: { value: new THREE.Color(0.55, 0.80, 1.0) },
    uColB: { value: new THREE.Color(1.0, 0.62, 0.22) },
    uStr: { value: 1.85 },
  };
  const m = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: ADD_VERT,
    fragmentShader: /* glsl */`
      precision highp float;
      uniform float uTime, uStr, uDamage;
      uniform vec3 uColA, uColB;
      varying vec2 vU;
      varying vec3 vPar;
      void main() {
        float d = vU.x;                              // metres along the bar
        float t = fract(d / 12.5);
        float dash = smoothstep(0.02, 0.10, t) * (1.0 - smoothstep(0.52, 0.66, t));
        float run = fract(d * 0.011 - uTime * 0.5);
        float chase = smoothstep(0.9, 1.0, run) * 1.1;
        float pulse = 0.85 + 0.15 * sin(uTime * 2.3 + vPar.x * 6.2831);
        vec3 c = mix(uColA, uColB, vPar.z);
        float a = (0.16 + 0.95 * dash + chase) * pulse * vPar.y;
        gl_FragColor = vec4(c * uStr * a * (1.0 + uDamage * 0.6), 1.0);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  (m as any).userData.uniforms = uniforms;
  return m;
}

function portGlowMaterial(): THREE.ShaderMaterial {
  const uniforms = { uTime: { value: 0 }, uDamage: { value: 0 }, uStr: { value: 2.1 } };
  const m = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */`
      varying vec3 vLocal;
      void main() {
        vLocal = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      precision highp float;
      uniform float uTime, uStr, uDamage;
      varying vec3 vLocal;
      void main() {
        float d = clamp(-vLocal.y / 190.0, 0.0, 1.0);
        vec3 c = mix(vec3(1.0, 0.46, 0.10), vec3(1.0, 0.84, 0.42), d * d);
        float boil = 0.80 + 0.20 * sin(uTime * 1.7 + vLocal.y * 0.06) * sin(uTime * 2.9 + vLocal.x * 0.3);
        float amt = (0.95 + 1.8 * d) * boil * (1.0 + uDamage * 2.0);
        gl_FragColor = vec4(c * uStr * amt, 1.0);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  (m as any).userData.uniforms = uniforms;
  return m;
}

function glowMaterial(): THREE.ShaderMaterial {
  const uniforms = {
    uTime: { value: 0 }, uDamage: { value: 0 },
    uStr: { value: 3.0 },
  };
  const m = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: ADD_VERT,
    fragmentShader: /* glsl */`
      precision highp float;
      uniform float uTime, uStr, uDamage;
      varying vec2 vU;
      varying vec3 vPar;
      float h12(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*0.1031); p3 += dot(p3,p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
      float vn(vec2 p){
        vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0-2.0*f);
        return mix(mix(h12(i), h12(i+vec2(1,0)), u.x), mix(h12(i+vec2(0,1)), h12(i+vec2(1,1)), u.x), u.y);
      }
      void main() {
        float kind = vPar.z;
        vec3 col;
        float a;
        if (kind < 0.5) {
          // warning beacon — hard pulsing blob
          float ph = vPar.x * 6.2831;
          float rate = 1.1 + vPar.y * 2.4;
          float p = pow(0.5 + 0.5 * sin(uTime * rate + ph), 3.0);
          col = mix(vec3(1.0, 0.35, 0.13), vec3(1.0, 0.86, 0.45), vPar.y);
          a = 0.85 + 2.1 * p;
        } else {
          // vent heat shimmer — soft, drifting
          vec2 uv = vU;
          float edge = smoothstep(0.0, 0.34, uv.x) * smoothstep(1.0, 0.66, uv.x)
                     * smoothstep(0.0, 0.22, uv.y) * smoothstep(1.0, 0.72, uv.y);
          float n = vn(vec2(uv.x * 5.0, uv.y * 3.0 - uTime * 0.9 - vPar.x * 20.0));
          float n2 = vn(vec2(uv.x * 11.0 + 3.0, uv.y * 7.0 - uTime * 1.7));
          float h = edge * (0.45 + 0.75 * n * n2 * 3.0);
          col = mix(vec3(1.0, 0.42, 0.10), vec3(0.55, 0.82, 1.0), step(0.62, vPar.y));
          a = h * (0.75 + 0.25 * sin(uTime * 1.5 + vPar.x * 9.0));
        }
        gl_FragColor = vec4(col * uStr * a * (1.0 + uDamage), 1.0);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  (m as any).userData.uniforms = uniforms;
  return m;
}

/* ------------------------------------------------------------ segment data */

interface Alloc { p: InstPool; i: number }

interface AnimRec {
  kind: number;          // 0 fan, 1 piston, 2 blast door
  pool: InstPool;
  slot: number;
  s: number;
  side: number;          // -1 / +1 wall it is attached to
  up: number;
  phase: number;
  rate: number;
  /** current intrusion into the trench, metres from the wall face (kinds 1,2) */
  reach: number;
  span: number;          // z half-extent for collision
}

interface SegRec {
  idx: number;
  allocs: Alloc[];
  wallL: TP.WallVariant;
  wallR: TP.WallVariant;
  floor: TP.FloorVariant;
  /** static lateral intrusions: {z0,z1 in trench s, side, depth from wall face} */
  blocks: { s0: number; s1: number; side: number; depth: number }[];
  anims: AnimRec[];
  turret: TrenchTurret | null;
}

/* ============================================================== the module */

export function createTrench(opts: { seed?: number } = {}): Trench {
  const seed = (opts.seed ?? 20770) >>> 0;
  const group = new THREE.Group();
  group.name = 'trench';
  group.matrixAutoUpdate = false;

  /* ---------------- materials ----------------
     three seeds `totalEmissiveRadiance = emissive`, so a non-black base emissive
     lights every pixel of the mesh instead of just the aEmis-masked windows and
     vents. createHullMaterial keeps it black; guard in case that ever regresses. */
  const hull = (o: Parameters<typeof createHullMaterial>[0]) => {
    const m = createHullMaterial(o);
    if (m.emissive.r + m.emissive.g + m.emissive.b > 0) m.emissiveIntensity = 0;
    return m;
  };
  const matPlate = hull({
    color: 0x6d747c, roughness: 0.80, metalness: 0.40, panelScale: 0.115,
    grime: 0.70, emissive: 0xffb45a, emissiveStrength: 2.6, windowDensity: 0.40,
  });
  const matDark = hull({
    color: 0x4b525a, roughness: 0.62, metalness: 0.44, panelScale: 0.24,
    grime: 0.82, emissive: 0xffbe72, emissiveStrength: 3.2, windowDensity: 0.5,
  });
  const matDeck = hull({
    color: 0x5c636b, roughness: 0.84, metalness: 0.38, panelScale: 0.055,
    grime: 0.62, emissive: 0xc8dcff, emissiveStrength: 2.2, windowDensity: 0.28,
  });
  const matPort = hull({
    color: 0x7e858c, roughness: 0.58, metalness: 0.50, panelScale: 0.22,
    grime: 0.70, emissive: 0xff9a2e, emissiveStrength: 4.2, windowDensity: 0.5,
  });
  const matStrip = stripMaterial();
  const matGlow = glowMaterial();
  const matPortGlow = portGlowMaterial();
  const materials: THREE.Material[] = [matPlate, matDark, matDeck, matPort, matStrip, matGlow, matPortGlow];

  /* ---------------- geometry libraries ---------------- */
  const wallVariants = TP.buildWallVariants(seed + 11);
  const wallApproach = TP.buildApproachWall(seed + 733);
  const floorVariants = TP.buildFloorVariants(seed + 29);
  const portFloorA = TP.buildPortFloor(seed + 401, -SEG / 2, PORT_HOLE_R);   // segment before PORT_S
  const portFloorB = TP.buildPortFloor(seed + 402, SEG / 2, PORT_HOLE_R);    // segment after PORT_S
  const deckSet = TP.buildDeckTiles(seed + 53);
  const deckGreebles = TP.buildDeckGreebles(seed + 71);
  const spans = TP.buildSpans(seed + 97);
  const props = TP.buildStaticProps(seed + 131);
  const anims = TP.buildAnimProps(seed + 157);
  const turretGeo = TP.buildTurretGeo(seed + 181, 2.3);

  /* ---------------- instanced pools ---------------- */
  const pools: InstPool[] = [];
  const add = (p: InstPool) => { pools.push(p); group.add(p.mesh); return p; };

  const nSegWin = Math.ceil((WIN_BACK + WIN_FWD) / SEG) + 3;

  const wallPools = wallVariants.map((v, i) => add(new InstPool(v.geo, matPlate, 34, 'wall' + i)));
  const approachPool = add(new InstPool(wallApproach.geo, matPlate, 40, 'wallApproach'));
  const floorPools = floorVariants.map((v, i) => add(new InstPool(v.geo, matPlate, 26, 'floor' + i)));
  const portFloorPools = [
    add(new InstPool(portFloorA.geo, matPlate, 2, 'floorPortA')),
    add(new InstPool(portFloorB.geo, matPlate, 2, 'floorPortB')),
  ];
  const deckNearPools = deckSet.near.map((g, i) => add(new InstPool(g, matDeck, 56, 'deckN' + i)));
  const deckMidPools = deckSet.mid.map((g, i) => add(new InstPool(g, matDeck, 40, 'deckM' + i)));
  const deckFarPools = deckSet.far.map((g, i) => add(new InstPool(g, matDeck, 24, 'deckF' + i)));
  const greeblePools = deckGreebles.map((g, i) => add(new InstPool(g, matDeck, 200, 'greeb' + i)));
  const spanPools = spans.map((g, i) => add(new InstPool(g, matDark, i === 3 ? 150 : 14, 'span' + i)));
  const bulkheadPool = add(new InstPool(props.bulkhead, matDark, 16, 'bulkhead'));
  const cablePool = add(new InstPool(props.cables, matDark, 22, 'cables'));
  const pylonPool = add(new InstPool(props.pylon, matDark, 20, 'pylon'));
  const bracketPool = add(new InstPool(props.bracket, matDark, 22, 'bracket'));
  const floodPool = add(new InstPool(props.flood, matDark, 26, 'flood'));
  const housingPool = add(new InstPool(anims.housing, matDark, 12, 'fanHousing'));
  const fanPool = add(new InstPool(anims.fan, matDark, 12, 'fan'));
  const pistonPool = add(new InstPool(anims.piston, matDark, 12, 'piston'));
  const doorPool = add(new InstPool(anims.door, matDark, 16, 'door'));
  const turretBasePool = add(new InstPool(turretGeo.base, matDark, 26, 'turretBase'));
  const turretHeadPool = add(new InstPool(turretGeo.head, matDark, 26, 'turretHead'));
  const turretBarrelPool = add(new InstPool(turretGeo.barrels, matDark, 26, 'turretBarrels'));
  // turret matrices are written straight from the Object3D hierarchy each frame,
  // never through alloc(), so their draw range has to be opened up by hand
  for (const tp of [turretBasePool, turretHeadPool, turretBarrelPool]) tp.mesh.count = tp.cap;

  const stripPool = new ParamPool(TP.barGeo(SEG, 0.55, 0.55), matStrip, nSegWin * 4 + 8, 'strips');
  pools.push(stripPool); group.add(stripPool.mesh);
  const beaconPool = new ParamPool(TP.beaconGeo(1.05), matGlow, nSegWin * 8 + 40, 'beacons');
  pools.push(beaconPool); group.add(beaconPool.mesh);
  const ventPool = new ParamPool(TP.glowQuad(1, 1), matGlow, nSegWin * 4 + 8, 'vents');
  pools.push(ventPool); group.add(ventPool.mesh);

  /* ---------------- static corridor filler (never a hole to the void) ---- */
  const fillerGeo = TP.buildFiller(MERIDIAN_CORRIDOR_S0 - 200, MERIDIAN_CORRIDOR_S1 + 200);
  const fillerMesh = new THREE.Mesh(fillerGeo, matDeck);
  fillerMesh.frustumCulled = false;
  fillerMesh.name = 'trenchFiller';
  group.add(fillerMesh);

  /* ---------------- end caps ---------------- */
  const capGeo = TP.buildEndCap(seed + 211);
  const capMesh = new THREE.InstancedMesh(capGeo, matDark, 2);
  capMesh.frustumCulled = false;
  {
    const m = new THREE.Matrix4();
    lmat(MERIDIAN_CORRIDOR_S1 - 60, centreAt(MERIDIAN_CORRIDOR_S1 - 60), floorAt(MERIDIAN_CORRIDOR_S1 - 60), 0, Math.PI, 0, 1, 1, 1, m);
    capMesh.setMatrixAt(0, m);
    lmat(MERIDIAN_CORRIDOR_S0 + 60, centreAt(MERIDIAN_CORRIDOR_S0 + 60), floorAt(MERIDIAN_CORRIDOR_S0 + 60), 0, 0, 0, 1, 1, 1, m);
    capMesh.setMatrixAt(1, m);
    capMesh.instanceMatrix.needsUpdate = true;
  }
  group.add(capMesh);

  /* ---------------- exhaust port ---------------- */
  const portGeo = TP.buildPort(seed + 313, PORT_RADIUS);
  const port = new THREE.Group();
  port.name = 'exhaustPort';
  const portHull = new THREE.Mesh(portGeo.hull, matPort);
  const portDark = new THREE.Mesh(portGeo.dark, matDark);
  const portGlow = new THREE.Mesh(portGeo.glow, matPortGlow);
  portHull.frustumCulled = false; portDark.frustumCulled = false; portGlow.frustumCulled = false;
  port.add(portHull, portDark, portGlow);
  {
    const fu = floorAt(PORT_S);
    trenchToWorld(PORT_S, 0, fu, port.position);
    trenchQuat(PORT_S, port.quaternion);
  }
  group.add(port);
  // the mouth sits on top of the raised emplacement crown
const PORT_MOUTH_UP = 13.5;
  const portMouth = trenchToWorld(PORT_S, 0, floorAt(PORT_S) + PORT_MOUTH_UP, new THREE.Vector3());

  /* ---------------- turret pool ---------------- */
  const turretRoot = new THREE.Group();
  turretRoot.name = 'trenchTurrets';
  group.add(turretRoot);

  interface TurretSlot extends TrenchTurret { slot: number; inUse: boolean }
  const turretSlots: TurretSlot[] = [];
  for (let i = 0; i < 24; i++) {
    const root = new THREE.Object3D();
    const head = new THREE.Object3D();
    const barrels = new THREE.Object3D();
    head.position.y = turretGeo.headY;
    barrels.position.y = turretGeo.barrelY;
    head.add(barrels);
    root.add(head);
    turretRoot.add(root);
    const t: TurretSlot = {
      root, head, barrels,
      muzzle: new THREE.Vector3(),
      s: 0, lateral: 0, up: 0, side: 0, alive: false, cooldown: 0,
      slot: i, inUse: false,
      destroy() { this.alive = false; },
    };
    turretSlots.push(t);
  }
  const turrets: TrenchTurret[] = [];
  const freeTurrets: number[] = turretSlots.map((_, i) => i).reverse();

  /* ---------------- segment composition ---------------- */

  // a fixed permutation guarantees the (wallL, wallR, floor) triple never
  // repeats inside 320 segments (= 80 km), far beyond the "12 segments" rule
  const NV = wallVariants.length;            // 8
  const NF = floorVariants.length;           // 5
  const KEYS = NV * NV * NF;                 // 320
  const perm = (() => {
    const a = new Array<number>(KEYS);
    for (let i = 0; i < KEYS; i++) a[i] = i;
    const r = new RNG(seed + 9001);
    for (let i = KEYS - 1; i > 0; i--) { const j = r.int(0, i); const t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  })();
  const STRIDE = 137;                        // coprime with 320

  const segs = new Map<number, SegRec>();
  let animCount = 0;

  function segRng(idx: number, salt: number) {
    return new RNG(((Math.imul(idx + 4096, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b) ^ seed) >>> 0) || 1);
  }

  function buildSegment(idx: number): SegRec {
    const rng = segRng(idx, 0);
    const s0 = idx * SEG, sMid = s0 + SEG / 2;
    const c = centreAt(sMid), hw = halfWidthAt(sMid), fu = floorAt(sMid);
    const gC = dCentre(sMid), gH = dHalfWidth(sMid), gF = dFloor(sMid);
    const inApproach = sMid > APPROACH_S0 && sMid < PORT_S + 900;
    // the drop-in point and the final approach both stay free of obstacles
    const clearZone = (sMid > PORT_S - 800 && sMid < PORT_S + 330) || Math.abs(sMid) < 340;
    // nothing that spans the trench for the last 1.8 km: the port must stay in sight
    const noBlockers = sMid > PORT_S - 1800 && sMid < PORT_S + 400;

    const key = perm[imod(idx * STRIDE, KEYS)];
    let vL = key % NV;
    let vR = (Math.floor(key / NV)) % NV;
    const vF = (Math.floor(key / (NV * NV))) % NF;

    const rec: SegRec = {
      idx, allocs: [],
      wallL: wallVariants[vL], wallR: wallVariants[vR], floor: floorVariants[vF],
      blocks: [], anims: [], turret: null,
    };

    const alloc = (p: InstPool, m: THREE.Matrix4) => {
      const i = p.alloc(m);
      if (i >= 0) rec.allocs.push({ p, i });
      return i;
    };

    /* ---- walls ---- */
    const yawR = -(gC + gH);
    const yawL = Math.PI - (gC - gH);
    let poolL = wallPools[vL], poolR = wallPools[vR];
    if (inApproach) {
      if (imod(idx, 2) === 0) { poolL = approachPool; rec.wallL = wallApproach; }
      else { poolR = approachPool; rec.wallR = wallApproach; }
    }
    alloc(poolR, lmat(sMid, c + hw, 0, 0, yawR, 0));
    alloc(poolL, lmat(sMid, c - hw, 0, 0, yawL, 0));

    /* ---- floor ---- */
    let fPool = floorPools[vF];
    if (idx === Math.floor(PORT_S / SEG) - 1) { fPool = portFloorPools[0]; rec.floor = portFloorA; }
    else if (idx === Math.floor(PORT_S / SEG)) { fPool = portFloorPools[1]; rec.floor = portFloorB; }
    alloc(fPool, lmat(sMid, c, fu, gF, -gC, 0));

    /* ---- surface deck ---- */
    for (const side of [-1, 1]) {
      const yaw = side > 0 ? 0 : Math.PI;
      const dn = deckNearPools[rng.int(0, deckNearPools.length - 1)];
      alloc(dn, lmat(sMid, 0, 0, 0, yaw, 0));
      if (imod(idx, 2) === 0) {
        const dm = deckMidPools[rng.int(0, deckMidPools.length - 1)];
        alloc(dm, lmat(s0 + SEG, 0, 0, 0, yaw, 0));
      }
      if (imod(idx, 4) === 0) {
        const df = deckFarPools[rng.int(0, deckFarPools.length - 1)];
        alloc(df, lmat(s0 + SEG * 2, 0, 0, 0, yaw, 0));
      }
      // silhouette hardware on the deck, thinning outward
      const nG = rng.int(7, 11);
      for (let i = 0; i < nG; i++) {
        const t = Math.pow(rng.next(), 0.6);
        const lat = side * lerp(TP.DECK_INNER + 25, TP.CORRIDOR_HALF - 40, t);
        const gs = lerp(1.0, 4.6, t) * rng.range(0.75, 1.4);
        const gp = greeblePools[rng.int(0, greeblePools.length - 1)];
        alloc(gp, lmat(s0 + rng.range(6, SEG - 6), lat, TP.deckTopY(lat), 0, rng.range(0, Math.PI * 2), 0, gs, gs, gs));
      }
    }

    /* ---- overhead spans ---- */
    if (rng.bool(0.46) && !clearZone) {
      const sp = spanPools[rng.int(0, 2)];
      const up = rng.bool(0.45) ? rng.range(-28, -16) : rng.range(-86, -62);
      alloc(sp, lmat(s0 + rng.range(30, SEG - 30), c, up, 0, rng.range(-0.05, 0.05), 0));
    }
    // slim structural ribs near the trench top: the main speed cue overhead
    if (!clearZone) {
      const nR = rng.int(1, 3);
      for (let i = 0; i < nR; i++) {
        const rs = s0 + ((i + 0.5) / nR) * SEG + rng.range(-24, 24);
        alloc(spanPools[3], lmat(rs, centreAt(rs), rng.range(-15, -7), 0, 0, 0));
      }
    }

    /* ---- in-trench obstacles ---- */
    const nProps = clearZone ? 0 : rng.int(0, 3);
    for (let i = 0; i < nProps; i++) {
      const ps = s0 + rng.range(18, SEG - 18);
      const pc = centreAt(ps), phw = halfWidthAt(ps), pfu = floorAt(ps);
      const k = rng.next();
      if (k < 0.22 && !noBlockers) {
        // partial bulkhead, leaves a gap on one side
        const side = rng.bool() ? 1 : -1;
        alloc(bulkheadPool, lmat(ps, pc + side * phw, 0, 0, side > 0 ? Math.PI : 0, 0));
        rec.blocks.push({ s0: ps - 9, s1: ps + 9, side, depth: 78 });
      } else if (k < 0.46) {
        alloc(cablePool, lmat(ps, pc + rng.range(-phw + 16, phw - 16), 0, 0, rng.range(0, 3), 0));
      } else if (k < 0.62) {
        alloc(pylonPool, lmat(ps, pc + rng.sign() * rng.range(26, phw - 12), pfu, 0, rng.range(0, 3), 0));
        rec.blocks.push({ s0: ps - 10, s1: ps + 10, side: 0, depth: 0 });
      } else if (k < 0.82 && animCount < MAX_ANIM) {
        // rotating fan set into a wall
        const side = rng.bool() ? 1 : -1;
        const up = rng.range(-88, -30);
        const ey = side > 0 ? -Math.PI / 2 : Math.PI / 2;
        alloc(housingPool, lmat(ps, pc + side * (phw - 3), up, 0, ey, 0));
        const slot = fanPool.alloc(lmat(ps, pc + side * (phw - 5), up, 0, ey, 0));
        if (slot >= 0) {
          rec.allocs.push({ p: fanPool, i: slot });
          rec.anims.push({ kind: 0, pool: fanPool, slot, s: ps, side, up, phase: rng.range(0, 6.28), rate: rng.range(1.2, 3.4) * rng.sign(), reach: 20, span: 20 });
          animCount++;
        }
      } else if (animCount < MAX_ANIM) {
        // extending piston ram
        const side = rng.bool() ? 1 : -1;
        const up = rng.range(-92, -26);
        const slot = pistonPool.alloc(lmat(ps, pc + side * phw, up, 0, side > 0 ? Math.PI : 0, 0));
        if (slot >= 0) {
          rec.allocs.push({ p: pistonPool, i: slot });
          rec.anims.push({ kind: 1, pool: pistonPool, slot, s: ps, side, up, phase: rng.range(0, 6.28), rate: rng.range(0.35, 0.75), reach: 0, span: 6 });
          animCount++;
        }
      }
    }

    /* ---- retractable blast door ---- */
    if (rng.bool(0.11) && animCount < MAX_ANIM - 1 && !noBlockers) {
      const ds = s0 + rng.range(40, SEG - 40);
      const dc = centreAt(ds), dhw = halfWidthAt(ds);
      for (const side of [-1, 1] as const) {
        const slot = doorPool.alloc(lmat(ds, dc + side * dhw, 0, 0, side > 0 ? Math.PI : 0, 0));
        if (slot >= 0) {
          rec.allocs.push({ p: doorPool, i: slot });
          rec.anims.push({ kind: 2, pool: doorPool, slot, s: ds, side, up: 0, phase: (idx * 0.7) % 6.283, rate: 0.16, reach: 0, span: 5 });
          animCount++;
        }
      }
    }

    /* ---- approach cues in the last 2 km ---- */
    if (inApproach) {
      for (const side of [-1, 1]) {
        if (imod(idx, 2) === (side > 0 ? 0 : 1)) {
          const fs = s0 + rng.range(40, SEG - 40);
          const fc = centreAt(fs), fhw = halfWidthAt(fs);
          alloc(floodPool, lmat(fs, fc + side * (fhw + 26), 0.2, 0, 0, side * 0.16));
        }
      }
      // extra beacons converging on the port
      for (let i = 0; i < 4; i++) {
        const bs = s0 + ((i + 0.5) / 4) * SEG;
        const bc = centreAt(bs), bhw = halfWidthAt(bs);
        for (const side of [-1, 1]) {
          const bi = beaconPool.alloc(lmat(bs, bc + side * (bhw - 2), -6, 0, 0, 0, 2.2, 2.2, 2.2));
          if (bi >= 0) { beaconPool.setParams(bi, (i * 0.25 + idx * 0.13) % 1, 0.15, 0); rec.allocs.push({ p: beaconPool, i: bi }); }
        }
      }
    }

    /* ---- turbolaser emplacement ---- */
    if (rng.bool(0.3)) {
      const ti = freeTurrets.pop();
      if (ti !== undefined) {
        const t = turretSlots[ti];
        const ts = s0 + rng.range(30, SEG - 30);
        const tc = centreAt(ts), thw = halfWidthAt(ts);
        const mode = imod(idx, 3);
        let side: -1 | 0 | 1;
        let lat: number, up: number;
        if (mode === 2) {
          side = 0;
          const sg = rng.bool() ? 1 : -1;
          lat = tc + sg * (thw + rng.range(28, 84));
          up = 0.2;
        } else {
          side = mode === 0 ? -1 : 1;
          up = rng.range(-74, -24);
          lat = tc + side * (thw - 10);
          alloc(bracketPool, lmat(ts, tc + side * thw, up, 0, side > 0 ? Math.PI : 0, 0));
        }
        trenchToWorld(ts, lat, up, t.root.position);
        trenchQuat(ts, t.root.quaternion);
        t.root.scale.set(1, 1, 1);
        t.s = ts; t.lateral = lat; t.up = up; t.side = side;
        t.alive = true; t.cooldown = rng.range(0.5, 2.5);
        t.inUse = true;
        t.head.rotation.set(0, 0, 0);
        t.barrels.rotation.set(0, 0, 0);
        rec.turret = t;
      }
    }

    /* ---- strip lights ---- */
    {
      const wallStripUp = 1.9;
      for (const side of [-1, 1]) {
        const yaw = side > 0 ? yawR : yawL;
        const si = stripPool.alloc(lmat(sMid, c + side * (hw + 1.0), wallStripUp, 0, yaw, 0));
        if (si >= 0) { stripPool.setParams(si, (idx * 0.37) % 1, 1.0, 0.0); rec.allocs.push({ p: stripPool, i: si }); }
        const fi = stripPool.alloc(lmat(sMid, c + side * (hw - 14), fu + 2.4, gF, yaw - (side > 0 ? 0 : Math.PI), 0));
        if (fi >= 0) { stripPool.setParams(fi, (idx * 0.61 + 0.4) % 1, 0.62, 1.0); rec.allocs.push({ p: stripPool, i: fi }); }
      }
    }

    /* ---- beacons + vent shimmer ---- */
    {
      const nB = rng.int(3, 6);
      for (let i = 0; i < nB; i++) {
        const bs = s0 + rng.range(4, SEG - 4);
        const bc = centreAt(bs), bhw = halfWidthAt(bs);
        const side = rng.bool() ? 1 : -1;
        const k = rng.next();
        const up = k < 0.35 ? rng.range(2.4, 4.0) : rng.range(-96, -12);
        const lat = bc + side * (bhw - (k < 0.35 ? -3 : rng.range(1, 6)));
        const bi = beaconPool.alloc(lmat(bs, lat, up, 0, 0, 0, rng.range(1.0, 2.0), rng.range(1.0, 2.0), rng.range(1.0, 2.0)));
        if (bi >= 0) { beaconPool.setParams(bi, rng.next(), rng.next(), 0); rec.allocs.push({ p: beaconPool, i: bi }); }
      }
      const nV = rng.int(1, 3);
      for (let i = 0; i < nV; i++) {
        const vs = s0 + rng.range(20, SEG - 20);
        const vc = centreAt(vs), vhw = halfWidthAt(vs);
        const side = rng.bool() ? 1 : -1;
        const up = rng.range(-98, -20);
        const w = rng.range(9, 22), h = rng.range(7, 20);
        const vi = ventPool.alloc(lmat(vs, vc + side * (vhw - 2.2), up, 0, side > 0 ? -Math.PI / 2 : Math.PI / 2, 0, w, h, 1));
        if (vi >= 0) { ventPool.setParams(vi, rng.next(), rng.next(), 1); rec.allocs.push({ p: ventPool, i: vi }); }
      }
    }

    return rec;
  }

  function releaseSegment(rec: SegRec) {
    for (const a of rec.allocs) a.p.release(a.i);
    rec.allocs.length = 0;
    animCount -= rec.anims.length;
    rec.anims.length = 0;
    if (rec.turret) {
      const t = rec.turret as TurretSlot;
      t.alive = false; t.inUse = false;
      t.root.position.set(0, -1e6, 0);
      turretBasePool.set(t.slot, ZERO);
      turretHeadPool.set(t.slot, ZERO);
      turretBarrelPool.set(t.slot, ZERO);
      freeTurrets.push(t.slot);
      rec.turret = null;
    }
  }

  function refreshTurretList() {
    turrets.length = 0;
    for (const t of turretSlots) if (t.inUse) turrets.push(t);
  }

  /* ---------------- streaming ---------------- */
  let lastI0 = 1 << 30, lastI1 = -(1 << 30);
  let damage = 0;
  const _im = new THREE.Matrix4();
  const _inv = new THREE.Matrix4();
  const _muz = new THREE.Vector3();

  function stream(playerS: number) {
    const i0 = Math.max(SEG_MIN, Math.floor((playerS - WIN_BACK) / SEG));
    const i1 = Math.min(SEG_MAX, Math.floor((playerS + WIN_FWD) / SEG));
    if (i0 === lastI0 && i1 === lastI1) return;
    lastI0 = i0; lastI1 = i1;
    for (const [idx, rec] of segs) {
      if (idx < i0 || idx > i1) { releaseSegment(rec); segs.delete(idx); }
    }
    for (let i = i0; i <= i1; i++) if (!segs.has(i)) segs.set(i, buildSegment(i));
    refreshTurretList();
  }

  /* ---------------- animation ---------------- */
  function animate(time: number) {
    for (const rec of segs.values()) {
      for (const a of rec.anims) {
        const sMidC = centreAt(a.s), sMidH = halfWidthAt(a.s);
        if (a.kind === 0) {
          const ey = a.side > 0 ? -Math.PI / 2 : Math.PI / 2;
          a.pool.set(a.slot, lmat(a.s, sMidC + a.side * (sMidH - 5), a.up, 0, ey, time * a.rate + a.phase));
        } else if (a.kind === 1) {
          const t = 0.5 - 0.5 * Math.cos(time * a.rate * 2 + a.phase);
          a.reach = 44 * t;
          a.pool.set(a.slot, lmat(a.s, sMidC + a.side * (sMidH + (1 - t) * 30), a.up, 0, a.side > 0 ? Math.PI : 0, 0));
        } else {
          const cyc = (time * a.rate + a.phase / 6.283) % 1;
          const t = smoothstep(0.06, 0.34, cyc) * (1 - smoothstep(0.62, 0.9, cyc));
          a.reach = 68 * t;
          a.pool.set(a.slot, lmat(a.s, sMidC + a.side * (sMidH + (1 - t) * 62), 0, 0, a.side > 0 ? Math.PI : 0, 0));
        }
      }
    }
  }

  function updateTurrets() {
    if (!turrets.length) return;
    turretRoot.updateMatrixWorld(true);
    _inv.copy(group.matrixWorld).invert();
    for (const t of turretSlots) {
      if (!t.inUse) continue;
      if (!t.alive) {
        turretBasePool.set(t.slot, ZERO);
        turretHeadPool.set(t.slot, ZERO);
        turretBarrelPool.set(t.slot, ZERO);
        continue;
      }
      _im.multiplyMatrices(_inv, t.root.matrixWorld);
      turretBasePool.set(t.slot, _im);
      _im.multiplyMatrices(_inv, t.head.matrixWorld);
      turretHeadPool.set(t.slot, _im);
      _im.multiplyMatrices(_inv, t.barrels.matrixWorld);
      turretBarrelPool.set(t.slot, _im);
      _muz.set(0, 0, turretGeo.muzzleZ).applyMatrix4(t.barrels.matrixWorld);
      t.muzzle.copy(_muz);
    }
  }

  /* ---------------- collision ---------------- */
  function collide(s: number, lateral: number, up: number, radius: number) {
    const c = centreAt(s);
    const hw = halfWidthAt(s);
    const fu = floorAt(s);
    const idx = Math.floor(s / SEG);
    const rec = segs.get(idx);
    const tz = clamp((s - idx * SEG) / SEG, 0, 0.999999);

    let protR = 3.0, protL = 3.0, rise = 2.0;
    if (rec) {
      protR = rec.wallR.prot(tz, up);
      protL = rec.wallL.prot(1 - tz, up);
      rise = rec.floor.rise(tz, lateral - c);
      for (const b of rec.blocks) {
        if (s < b.s0 || s > b.s1 || b.depth <= 0) continue;
        if (b.side > 0) protR = Math.max(protR, b.depth);
        else if (b.side < 0) protL = Math.max(protL, b.depth);
      }
      for (const a of rec.anims) {
        if (a.reach <= 0.5) continue;
        if (Math.abs(s - a.s) > a.span + radius) continue;
        if (a.side > 0) protR = Math.max(protR, a.reach);
        else protL = Math.max(protL, a.reach);
      }
    }

    let outLat = lateral, outUp = up, hit = false;
    let nx = 0, ny = 0;

    const limR = c + hw - protR - radius;
    const limL = c - hw + protL + radius;
    if (limR > limL) {
      if (outLat > limR) { outLat = limR; hit = true; nx = -1; }
      else if (outLat < limL) { outLat = limL; hit = true; nx = 1; }
    } else {
      const mid = (limR + limL) * 0.5;
      if (Math.abs(outLat - mid) > 0.001) { nx = outLat > mid ? -1 : 1; }
      outLat = mid; hit = true;
    }

    const floorLimit = fu + rise + radius;
    if (outUp < floorLimit) { outUp = floorLimit; hit = true; ny = 1; }

    const normal = new THREE.Vector3();
    if (hit) {
      if (ny > 0 && nx === 0) trenchRadial(s, normal);
      else {
        trenchRadial(s, normal).multiplyScalar(ny);
        normal.z += nx;
        if (normal.lengthSq() < 1e-6) normal.set(0, 0, nx || 1);
        normal.normalize();
      }
    }
    return { lateral: outLat, up: outUp, hit, normal };
  }

  /* ---------------- public update ---------------- */
  let started = false;
  function update(dt: number, time: number, playerS: number, camera: THREE.Camera) {
    void dt; void camera;
    if (!started) { group.updateMatrix(); group.updateMatrixWorld(true); started = true; }
    stream(playerS);
    animate(time);
    updateTurrets();
    for (const p of pools) p.flush();
    updateHullMaterials(materials, time, damage);
  }

  function setDamage(v: number) { damage = clamp(v, 0, 1); }

  function dispose() {
    for (const p of pools) { p.mesh.geometry.dispose(); }
    for (const m of materials) m.dispose();
    capGeo.dispose(); fillerGeo.dispose();
    portGeo.hull.dispose(); portGeo.dark.dispose(); portGeo.glow.dispose();
    group.removeFromParent();
  }

  // prime the first window so the integrator can measure counts immediately
  stream(0);

  return {
    group, turrets, materials,
    update, collide,
    port, portMouth,
    setDamage, dispose,
  };
}
